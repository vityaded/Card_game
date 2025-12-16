import { nanoid } from "nanoid";
import { nowMs, handTotal } from "./utils.js";
import { buildDeck, deal, startTurnTracker, makeSpinner, spinnerPickIndex, checkSets } from "./gameLogic.js";
import { loadTemplate } from "./templates.js";

const ROOM_TTL_MS = 10 * 60 * 1000;

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomId -> room
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
      turnIndex: 0,
      activePlayerId: null,

      deck: [],
      publicSets: new Map(),

      turnTracker: null,
      lastActivityAt: nowMs(),
    };
    this.rooms.set(id, room);
    return room;
  }

  get(roomId) { return this.rooms.get(roomId); }

  touch(room) { room.lastActivityAt = nowMs(); }

  setHost(roomId, socketId) {
    const room = this.get(roomId);
    if (!room) return null;
    room.host.socketId = socketId;
    this.touch(room);
    return room;
  }

  addPlayer(roomId, name) {
    const room = this.get(roomId);
    if (!room) throw new Error("room_not_found");
    if (room.phase !== "lobby") throw new Error("room_closed");
    if (room.players.size >= 6) throw new Error("room_full");

    const playerId = nanoid(10);
    const secret = nanoid(16);
    const player = {
      id: playerId,
      name: String(name || "Player").slice(0, 30),
      secret,
      socketId: null,
      handCounts: new Map(),
      setsCount: 0
    };
    room.players.set(playerId, player);
    this.touch(room);
    return { room, player };
  }

  resumePlayer(roomId, playerId, secret, socketId) {
    const room = this.get(roomId);
    if (!room) return { ok: false, reason: "room_not_found" };
    const p = room.players.get(playerId);
    if (!p || p.secret !== secret) return { ok: false, reason: "bad_secret" };
    p.socketId = socketId;
    this.touch(room);
    return { ok: true, room, player: p };
  }

  disconnectSocket(socketId) {
    for (const room of this.rooms.values()) {
      if (room.host.socketId === socketId) room.host.socketId = null;
      for (const p of room.players.values()) {
        if (p.socketId === socketId) p.socketId = null;
      }
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
    for (let i = room.order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.order[i], room.order[j]] = [room.order[j], room.order[i]];
    }

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
    room.turnIndex = 0;
    room.activePlayerId = null;
    room.deck = [];
    room.publicSets = new Map();
    room.turnTracker = null;
    for (const p of room.players.values()) {
      p.handCounts = new Map();
      p.setsCount = 0;
    }
    this.touch(room);
    return room;
  }

  removePlayer(roomId, playerId) {
    const room = this.get(roomId);
    if (!room) throw new Error("room_not_found");
    const p = room.players.get(playerId);
    if (!p) return room;

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
      }
    }
  }
}

export function snapshotForHost(room) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      id: p.id, name: p.name,
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
    activePlayerId: room.activePlayerId,
    deckCount: room.deck.length,
    publicSets,
    me: { id: playerId, hand: myHand }
  };
}
