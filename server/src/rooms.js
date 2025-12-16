import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { nowMs, handTotal } from "./utils.js";
import { buildDeck, deal, startTurnTracker, makeSpinner, spinnerPickIndex, checkSets, addToHand } from "./gameLogic.js";
import { loadTemplate } from "./templates.js";

const ROOM_TTL_MINUTES = Number(process.env.ROOM_TTL_MINUTES || 240);
const ROOM_TTL_MS = ROOM_TTL_MINUTES * 60 * 1000;
const ROOMS_DIR = path.resolve("server/data/rooms");
const SAVE_DEBOUNCE_MS = 300;

export class RoomManager {
  constructor(io, logFn = () => {}) {
    this.io = io;
    this.log = logFn;
    this.rooms = new Map(); // roomId -> room
    this.socketToPlayer = new Map(); // socketId -> { roomId, playerId }
    this.saveTimers = new Map();

    this.ensureRoomsDir();
    this.loadRoomsFromDisk();
    setInterval(() => this.cleanup(), 60 * 1000).unref();
  }

  createRoom() {
    const id = nanoid(6).toUpperCase();
    const room = {
      id,
      phase: "lobby",
      host: { socketId: null },
      templateId: null,

      players: new Map(), // playerId -> player
      order: [],
      turnOrder: [],
      turnIndex: 0,
      activePlayerId: null,
      startedAt: null,

      deck: [],
      publicSets: new Map(),

      turnTracker: null,
      lastActivityAt: nowMs(),
    };
    this.rooms.set(id, room);
    this.scheduleSave(room);
    return room;
  }

  ensureRoomsDir() {
    try { fs.mkdirSync(ROOMS_DIR, { recursive: true }); } catch {}
  }

  scheduleSave(room) {
    if (!room?.id) return;
    const existing = this.saveTimers.get(room.id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.saveTimers.delete(room.id);
      this.persistRoom(room);
    }, SAVE_DEBOUNCE_MS);
    this.saveTimers.set(room.id, t);
  }

  persistRoom(room) {
    if (!room) return;
    const file = path.join(ROOMS_DIR, `${room.id}.json`);
    const payload = {
      roomId: room.id,
      phase: room.phase,
      templateId: room.templateId,
      deck: [...room.deck],
      players: [...room.players.values()].map(p => ({
        id: p.id,
        name: p.name,
        secret: p.secret,
        seat: p.seat,
        handCounts: Object.fromEntries([...p.handCounts.entries()].map(([k,v]) => [String(k), v])),
        setsCount: p.setsCount,
      })),
      order: [...room.order],
      turnOrder: [...room.turnOrder],
      turnIndex: room.turnIndex,
      activePlayerId: room.activePlayerId,
      publicSets: Object.fromEntries([...room.publicSets.entries()]),
      lastActivityAt: room.lastActivityAt,
      startedAt: room.startedAt,
    };
    try {
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    } catch (e) {
      this.log("persist_error", { roomId: room.id, error: String(e) });
    }
  }

  loadRoomsFromDisk() {
    this.ensureRoomsDir();
    const entries = fs.readdirSync(ROOMS_DIR).filter(f => f.endsWith(".json"));
    for (const file of entries) {
      try {
        const raw = fs.readFileSync(path.join(ROOMS_DIR, file), "utf8");
        const data = JSON.parse(raw);
        if (!data?.roomId) continue;
        if (nowMs() - Number(data.lastActivityAt || 0) > ROOM_TTL_MS) {
          fs.unlink(path.join(ROOMS_DIR, file), () => {});
          this.log("room_cleanup_disk", { roomId: data.roomId, reason: "ttl_expired" });
          continue;
        }
        const room = {
          id: data.roomId,
          phase: data.phase || "lobby",
          host: { socketId: null },
          templateId: data.templateId || null,
          players: new Map(),
          order: data.order || [],
          turnOrder: data.turnOrder || [],
          turnIndex: data.turnIndex || 0,
          activePlayerId: data.activePlayerId || null,
          startedAt: data.startedAt || null,
          deck: Array.isArray(data.deck) ? [...data.deck] : [],
          publicSets: new Map(Object.entries(data.publicSets || {})),
          turnTracker: null,
          lastActivityAt: data.lastActivityAt || nowMs(),
        };
        for (const p of data.players || []) {
          const player = {
            id: p.id,
            name: p.name,
            secret: p.secret,
            socketId: null,
            handCounts: new Map(Object.entries(p.handCounts || {}).map(([k,v]) => [Number(k), Number(v)])),
            setsCount: p.setsCount || 0,
            seat: p.seat || null,
          };
          room.players.set(player.id, player);
        }
        this.rooms.set(room.id, room);
        this.log("room_loaded", { roomId: room.id, phase: room.phase, players: room.players.size });
      } catch (e) {
        this.log("room_load_error", { file, error: String(e) });
      }
    }
  }

  get(roomId) { return this.rooms.get(roomId); }

  touch(room) { room.lastActivityAt = nowMs(); this.scheduleSave(room); }

  setHost(roomId, socketId) {
    const room = this.get(roomId);
    if (!room) return null;
    room.host.socketId = socketId;
    this.touch(room);
    return room;
  }

  normalizeName(name) { return String(name || "").trim().toLowerCase(); }

  findPlayerByName(room, name) {
    const target = this.normalizeName(name);
    for (const p of room.players.values()) {
      if (this.normalizeName(p.name) === target) return p;
    }
    return null;
  }

  addPlayer(roomId, name) {
    const room = this.get(roomId);
    if (!room) throw new Error("room_not_found");
    if (room.players.size >= 6) throw new Error("room_full");

    const existing = this.findPlayerByName(room, name);
    if (existing) return { room, player: existing, reclaimed: true };

    const playerId = nanoid(10);
    const secret = nanoid(16);
    const player = {
      id: playerId,
      name: String(name || "Player").slice(0, 30),
      secret,
      socketId: null,
      handCounts: new Map(),
      setsCount: 0,
      seat: room.phase === "active" ? this.nextSeat(room) : null,
    };
    room.players.set(playerId, player);
    let dealt = 0;
    if (room.phase === "active") {
      dealt = this.appendLateJoin(room, playerId);
    }
    this.touch(room);
    return { room, player, dealt };
  }

  nextSeat(room) {
    let maxSeat = 0;
    for (const p of room.players.values()) {
      if (p.seat && p.seat > maxSeat) maxSeat = p.seat;
    }
    return maxSeat + 1;
  }

  appendLateJoin(room, playerId) {
    const pid = playerId;
    room.order = [...room.order, pid];
    room.turnOrder = [...room.turnOrder, pid];
    const player = room.players.get(pid);
    if (!player) return 0;
    const cardsToDeal = Math.min(4, room.deck.length);
    let dealt = 0;
    for (let i = 0; i < cardsToDeal; i++) {
      const card = room.deck.pop();
      if (card === undefined) break;
      addToHand(player, card, 1);
      dealt++;
    }
    checkSets(room, pid);
    const total = handTotal(player.handCounts);
    if (room.turnTracker && room.activePlayerId !== pid && total > 0) {
      room.turnTracker.eligible.add(pid);
    }
    return dealt;
  }

  resumePlayer(roomId, playerId, secret, socketId) {
    const room = this.get(roomId);
    if (!room) return { ok: false, reason: "room_not_found" };
    const p = room.players.get(playerId);
    if (!p || p.secret !== secret) return { ok: false, reason: "bad_secret" };
    this.bindPlayerSocket(room, p, socketId);
    this.touch(room);
    return { ok: true, room, player: p };
  }

  bindPlayerSocket(room, player, socketId) {
    if (!room || !player) return;
    if (player.socketId && player.socketId !== socketId) {
      try { this.io.sockets.sockets.get(player.socketId)?.disconnect(true); } catch {}
      this.socketToPlayer.delete(player.socketId);
    }
    player.socketId = socketId;
    this.socketToPlayer.set(socketId, { roomId: room.id, playerId: player.id });
  }

  disconnectSocket(socketId) {
    const binding = this.socketToPlayer.get(socketId);
    if (binding) {
      const room = this.get(binding.roomId);
      if (room) {
        const p = room.players.get(binding.playerId);
        if (p && p.socketId === socketId) p.socketId = null;
        this.touch(room);
      }
    }
    this.socketToPlayer.delete(socketId);
    for (const room of this.rooms.values()) {
      if (room.host.socketId === socketId) room.host.socketId = null;
    }
  }

  startGame(roomId, templateId) {
    const room = this.get(roomId);
    if (!room) throw new Error("room_not_found");
    if (room.phase !== "lobby") throw new Error("bad_phase");
    if (room.players.size < 2) throw new Error("need_2_players");
    room.templateId = templateId;
    const t = loadTemplate(templateId);
    if (!t) throw new Error("template_not_found");

    // order randomized
    room.order = [...room.players.keys()];
    room.turnOrder = [...room.order];
    for (let i = room.order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.order[i], room.order[j]] = [room.order[j], room.order[i]];
    }

    room.turnOrder = [...room.order];
    room.turnOrder.forEach((pid, i) => {
      const p = room.players.get(pid);
      if (p) p.seat = i + 1;
    });

    // reset hands/sets
    room.publicSets = new Map();
    for (const p of room.players.values()) {
      p.handCounts = new Map();
      p.setsCount = 0;
    }

    room.deck = buildDeck();
    deal(room, 4, Math.random);

    // spinner
    const spinner = makeSpinner();
    room.turnIndex = spinnerPickIndex(spinner.seed, room.order.length);
    room.activePlayerId = room.order[room.turnIndex];
    startTurnTracker(room);

    // check any immediate sets (rare but possible)
    for (const pid of room.order) checkSets(room, pid);

    room.startedAt = nowMs();
    room.phase = "active";
    this.touch(room);
    return { room, spinner };
  }

  newGame(roomId, templateId) {
    const room = this.get(roomId);
    if (!room) throw new Error("room_not_found");
    room.phase = "lobby";
    room.templateId = templateId || room.templateId;
    room.order = [];
    room.turnOrder = [];
    room.turnIndex = 0;
    room.activePlayerId = null;
    room.deck = [];
    room.publicSets = new Map();
    room.turnTracker = null;
    room.startedAt = null;
    for (const p of room.players.values()) {
      p.handCounts = new Map();
      p.setsCount = 0;
      p.seat = null;
    }
    this.touch(room);
    return room;
  }

  removePlayer(roomId, playerId) {
    const room = this.get(roomId);
    if (!room) throw new Error("room_not_found");
    const p = room.players.get(playerId);
    if (!p) return room;

    if (p.socketId) this.socketToPlayer.delete(p.socketId);

    // return all cards to deck (typeId repeated count times)
    for (const [typeId, cnt] of p.handCounts.entries()) {
      for (let i=0;i<cnt;i++) room.deck.push(Number(typeId));
    }
    // shuffle lightly
    for (let i = room.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
    }

    room.players.delete(playerId);
    // remove from order if active game
    room.order = room.order.filter(x => x !== playerId);
    room.turnOrder = room.turnOrder.filter(x => x !== playerId);
    if (room.activePlayerId === playerId) {
      room.activePlayerId = room.order[room.turnIndex % Math.max(1, room.order.length)] || null;
    }
    this.touch(room);
    return room;
  }

  roomHasAnyConnections(room) {
    if (room.host.socketId) return true;
    for (const p of room.players.values()) if (p.socketId) return true;
    return false;
  }

  cleanup() {
    const now = nowMs();
    for (const [id, room] of this.rooms.entries()) {
      const inactive = now - room.lastActivityAt > ROOM_TTL_MS;
      const noConn = !this.roomHasAnyConnections(room);
      if (inactive && noConn) {
        this.rooms.delete(id);
        try { fs.unlinkSync(path.join(ROOMS_DIR, `${id}.json`)); } catch {}
        this.log("room_cleanup", { roomId: id, reason: "ttl_expired" });
      }
    }
  }
}

export function snapshotForHost(room) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      id: p.id, name: p.name,
      seat: p.seat || null,
      hand: Object.fromEntries([...p.handCounts.entries()].map(([k,v]) => [String(k), v])),
      handTotal: handTotal(p.handCounts),
      setsCount: p.setsCount,
      online: !!p.socketId
    });
  }
  const publicSets = {};
  for (const [pid, info] of room.publicSets.entries()) publicSets[pid] = info;
  return {
    roomId: room.id,
    phase: room.phase,
    templateId: room.templateId,
    players,
    order: room.order,
    turnOrder: room.turnOrder,
    activePlayerId: room.activePlayerId,
    deckCount: room.deck.length,
    publicSets
  };
}

export function snapshotForPlayer(room, playerId) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      id: p.id, name: p.name,
      seat: p.seat || null,
      handTotal: handTotal(p.handCounts),
      setsCount: p.setsCount,
      online: !!p.socketId
    });
  }
  const me = room.players.get(playerId);
  const myHand = me ? Object.fromEntries([...me.handCounts.entries()].map(([k,v]) => [String(k), v])) : {};
  const publicSets = {};
  for (const [pid, info] of room.publicSets.entries()) publicSets[pid] = info;

  return {
    roomId: room.id,
    phase: room.phase,
    templateId: room.templateId,
    players,
    order: room.order,
    turnOrder: room.turnOrder,
    activePlayerId: room.activePlayerId,
    deckCount: room.deck.length,
    publicSets,
    me: { id: playerId, hand: myHand }
  };
}
