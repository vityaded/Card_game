import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import multer from "multer";
import { Server } from "socket.io";

import { RoomManager, snapshotForHost, snapshotForPlayer } from "./rooms.js";
import { listTemplates, createTemplateFromUpload, createTemplateDraft, finalizeTemplate, setTemplateGrid, sliceTemplate, renameTemplate, deleteTemplate, loadTemplate, getTemplatePaths } from "./templates.js";
import { giveToActiveWithMoved, endTurn } from "./gameLogic.js";

const PORT = process.env.PORT || 5007;

const app = express();

const LOG_PATH = path.resolve(process.cwd(), "game.log");

function log(event, data = null) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${event}` + (data ? ` ${JSON.stringify(data)}` : "") + "\n";
  try { fs.appendFileSync(LOG_PATH, line, "utf8"); } catch {}
  // also console
  console.log(line.trim());
}


app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    log("http", { method: req.method, url: req.originalUrl || req.url, status: res.statusCode, ms });
  });
  next();
});


process.on("unhandledRejection", (err) => log("unhandledRejection", { err: String(err), stack: err?.stack }));
process.on("uncaughtException", (err) => log("uncaughtException", { err: String(err), stack: err?.stack }));

app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const rooms = new RoomManager(io, log);

// Static public
app.use(express.static(path.resolve("public")));

// Upload storage (temp)
const upload = multer({ dest: path.resolve("server/data/_uploads") });

// API: rooms
app.get("/api/rooms/create", (req, res) => {
  const room = rooms.createRoom();

// Client logs (room.html inline + app-room.js)
app.post("/api/client-log", express.json({ limit: "200kb" }), (req, res) => {
  const payload = req.body || {};
  log("client", payload);
  res.json({ ok: true });
});


// API: room summary (for host dashboard)
app.get("/api/rooms/:roomId/summary", (req, res) => {
  const roomId = String(req.params.roomId || "").toUpperCase();
  const room = rooms.get(roomId);
  if (!room) return res.json({ exists: false, roomId });
  const activeName = (() => {
    const p = room.activePlayerId ? room.players.get(room.activePlayerId) : null;
    return p ? p.name : null;
  })();
  res.json({
    exists: true,
    roomId: room.id,
    phase: room.phase,
    playersCount: room.players.size,
    activeName,
    deckCount: room.deck.length,
    lastActivityAt: room.lastActivityAt
  });
});

app.get("/api/rooms/:roomId/players", (req, res) => {
  const roomId = String(req.params.roomId || "").toUpperCase();
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ roomId, exists: false });
  const players = [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    online: !!p.socketId,
  })).sort((a, b) => {
    const sa = a.seat ?? 999;
    const sb = b.seat ?? 999;
    if (sa === sb) return a.name.localeCompare(b.name);
    return sa - sb;
  });
  res.json({ roomId: room.id, phase: room.phase, players });
});

  res.json({
    roomId: room.id,
    hostUrl: `/host.html?roomId=${room.id}`,
    playerUrl: `/room.html?roomId=${room.id}`
  });
});

// API: templates
app.get("/api/templates", (req, res) => {
  res.json({ templates: listTemplates() });
});

app.post("/api/templates/draft", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "file_required" });
    const name = (req.body?.name || req.file?.originalname || "Template").toString();
    const out = await createTemplateDraft(req.file.path, name);
    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/templates/upload", upload.single("file"), async (req, res) => {
  try {
    const name = (req.body?.name || req.file?.originalname || "Template").toString();
    const out = await createTemplateFromUpload(req.file.path, name);
    // cleanup temp file
    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/templates/:id/finalize", async (req, res) => {
  try {
    const out = await finalizeTemplate(req.params.id, { name: req.body?.name, grid: req.body?.grid });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/templates/:id/source", (req, res) => {
  const t = loadTemplate(req.params.id);
  if (!t) return res.status(404).send("not found");
  res.sendFile(path.resolve(t.sourcePath));
});

app.get("/api/templates/:id/slice/:idx", (req, res) => {
  const t = loadTemplate(req.params.id);
  if (!t) return res.status(404).send("not found");
  const file = path.join(t.slicesDir, `${req.params.idx}.png`);
  if (!fs.existsSync(file)) return res.status(404).send("no slice");
  res.sendFile(path.resolve(file));
});

app.post("/api/templates/:id/grid", (req, res) => {
  const ok = setTemplateGrid(req.params.id, req.body?.grid);
  if (!ok) return res.status(400).json({ ok: false });
  res.json({ ok: true });
});

app.post("/api/templates/:id/slice", async (req, res) => {
  try {
    const out = await sliceTemplate(req.params.id);
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/templates/:id/rename", (req, res) => {
  const ok = renameTemplate(req.params.id, req.body?.name);
  if (!ok) return res.status(400).json({ ok: false });
  res.json({ ok: true });
});

app.delete("/api/templates/:id", (req, res) => {
  const ok = deleteTemplate(req.params.id);
  if (!ok) return res.status(400).json({ ok: false });
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  log("socket_connection", { id: socket.id, ip: socket.handshake.address, ua: socket.handshake.headers?.["user-agent"] });
socket.on("client_log", (payload) => {
  log("client_socket", { socketId: socket.id, payload });
});
  socket.on("disconnect", () => {
    log("socket_disconnect", { id: socket.id });
    rooms.disconnectSocket(socket.id);
  });

  // Host joins
  socket.on("host_join", ({ roomId }) => {
    log("host_join", { socketId: socket.id });

    const room = rooms.setHost(roomId, socket.id);
    if (!room) return socket.emit("error_msg", { error: "room_not_found" });
    socket.join(roomId);
    socket.emit("room_state", { snapshot: snapshotForHost(room) });
  });

  // Player join
  socket.on("player_join", ({ roomId, name }) => {
    log("player_join", { socketId: socket.id });

    try {
      const { room, player, reclaimed, dealt } = rooms.addPlayer(roomId, name);
      rooms.bindPlayerSocket(room, player, socket.id);
      socket.join(roomId);
      if (reclaimed) {
        log("CLAIM", { room: room.id, player: player.name, pid: player.id, newSocket: socket.id });
        socket.emit("claimed", {
          playerId: player.id,
          secret: player.secret,
          snapshot: snapshotForPlayer(room, player.id)
        });
      } else {
        if (room.phase === "active") {
          log("LATE_JOIN", { room: room.id, name: player.name, seat: player.seat, dealt, deckLeft: room.deck.length });
        }
        socket.emit("joined", {
          playerId: player.id,
          secret: player.secret,
          snapshot: snapshotForPlayer(room, player.id)
        });
      }
      // notify host and update everyone with correct per-socket snapshots
      broadcastState(room);
    } catch (e) {
      socket.emit("error_msg", { error: String(e?.message || e) });
    }
  });

  socket.on("resume", ({ roomId, playerId, secret }) => {
    const r = rooms.resumePlayer(roomId, playerId, secret, socket.id);
    if (!r.ok) return socket.emit("resume_fail", { reason: r.reason });
    socket.join(roomId);
    socket.emit("resume_ok", { snapshot: snapshotForPlayer(r.room, playerId) });
    broadcastState(r.room);
  });

  socket.on("player_claim", ({ roomId, playerId }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error_msg", { error: "room_not_found" });
    const player = room.players.get(playerId);
    if (!player) return socket.emit("error_msg", { error: "player_not_found" });
    rooms.bindPlayerSocket(room, player, socket.id);
    rooms.touch(room);
    socket.join(roomId);
    log("CLAIM", { room: room.id, player: player.name, pid: player.id, newSocket: socket.id });
    socket.emit("claimed", { playerId: player.id, secret: player.secret, snapshot: snapshotForPlayer(room, player.id) });
    broadcastState(room);
  });

  socket.on("game_start", ({ roomId, templateId }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error_msg", { error: "room_not_found" });
    if (room.host.socketId !== socket.id) return socket.emit("error_msg", { error: "not_host" });

    try {
      const { spinner } = rooms.startGame(roomId, templateId);
      // send start event with spinner info
      io.to(roomId).emit("game_started", { spinner });
      // broadcast state (host and players will receive their own views via separate emits)
      broadcastState(room);
    } catch (e) {
      socket.emit("error_msg", { error: String(e?.message || e) });
    }
  });

  socket.on("give_to_active", ({ roomId, playerId, secret, types }) => {
    log("give_to_active", { socketId: socket.id });

    const room = rooms.get(roomId);
    if (!room) return socket.emit("error_msg", { error: "room_not_found" });
    if (room.phase !== "active") return;
    // verify sender
    const p = room.players.get(playerId);
    if (!p || p.secret !== secret) return;
    if (p.socketId !== socket.id) return;
    if (playerId === room.activePlayerId) return;
    // transfer only during active turn (always true in game)
    const typeIds = Array.isArray(types) ? [...new Set(types)].map(x => Number(x)).filter(x => x>=0 && x<9) : [];
    if (typeIds.length === 0) return;

    giveToActiveWithMoved(room, playerId, typeIds);
    rooms.touch(room);
    broadcastState(room);
  });

  socket.on("end_turn", ({ roomId, playerId, secret }) => {
    log("end_turn", { socketId: socket.id });

    const room = rooms.get(roomId);
    if (!room) return socket.emit("error_msg", { error: "room_not_found" });
    if (room.phase !== "active") return;
    if (room.activePlayerId !== playerId) return;

    const p = room.players.get(playerId);
    if (!p || p.secret !== secret) return;
    if (p.socketId !== socket.id) return;

    endTurn(room, Math.random);
    rooms.touch(room);
    broadcastState(room);

    if (room.phase === "finished") {
      io.to(roomId).emit("game_finished", {});
    }
  });

  socket.on("host_remove_player", ({ roomId, playerId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.host.socketId !== socket.id) return;
    rooms.removePlayer(roomId, playerId);
    rooms.touch(room);
    broadcastState(room);
  });

  socket.on("game_new", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.host.socketId !== socket.id) return;
    rooms.newGame(roomId);
    rooms.touch(room);
    broadcastState(room);
  });

  function broadcastState(room) {
    // host snapshot
    if (room.host.socketId) io.to(room.host.socketId).emit("room_state", { snapshot: snapshotForHost(room) });
    // each player snapshot
    for (const p of room.players.values()) {
      if (!p.socketId) continue;
      io.to(p.socketId).emit("room_state", { snapshot: snapshotForPlayer(room, p.id) });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
