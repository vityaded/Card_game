import { shuffleInPlace, handTotal, mulberry32 } from "./utils.js";

export function buildDeck() {
  // 9 types * 4 copies
  const deck = [];
  for (let t=0;t<9;t++) for (let i=0;i<4;i++) deck.push(t);
  return deck;
}

export function deal(room, cardsPerPlayer=4, rng=Math.random) {
  shuffleInPlace(room.deck, rng);
  for (const pid of room.order) {
    for (let i=0;i<cardsPerPlayer;i++) {
      const card = room.deck.pop();
      if (card === undefined) break;
      addToHand(room.players.get(pid), card, 1);
    }
  }
}

export function addToHand(player, typeId, n) {
  const cur = player.handCounts.get(typeId) || 0;
  player.handCounts.set(typeId, cur + n);
}

export function removeAllOfType(player, typeId) {
  const n = player.handCounts.get(typeId) || 0;
  if (n > 0) player.handCounts.delete(typeId);
  return n;
}

export function drawOne(room, playerId) {
  if (room.deck.length === 0) return false;
  const card = room.deck.pop();
  addToHand(room.players.get(playerId), card, 1);
  return true;
}

export function startTurnTracker(room) {
  const eligible = new Set();
  const gave = new Set();
  for (const [pid, p] of room.players.entries()) {
    if (pid === room.activePlayerId) continue;
    if (handTotal(p.handCounts) > 0) eligible.add(pid);
  }
  room.turnTracker = { startedAt: Date.now(), eligible, gave };
}

export function giveToActive(room, senderId, typeIds) {
  const sender = room.players.get(senderId);
  const active = room.players.get(room.activePlayerId);
  if (!sender || !active) return;

  // For each selected type, transfer ALL copies
  for (const t of typeIds) {
    const moved = removeAllOfType(sender, t);
    if (moved > 0) addToHand(active, t, moved);
  }

  // mark sender as "gave" if actually moved at least one card total
  // (Even if types selected but counts were 0, does not count)
  // Determine moved by comparing selection quickly: recompute by scanning? We'll compute by checking if any selected type had moved >0.
  // We didn't store moved totals; do it again in safe way:
}

export function giveToActiveWithMoved(room, senderId, typeIds) {
  const sender = room.players.get(senderId);
  const active = room.players.get(room.activePlayerId);
  if (!sender || !active) return { movedTotal: 0, movedByType: {} };

  let movedTotal = 0;
  const movedByType = {};
  for (const t of typeIds) {
    const moved = removeAllOfType(sender, t);
    if (moved > 0) {
      addToHand(active, t, moved);
      movedTotal += moved;
      movedByType[t] = moved;
    }
  }
  if (movedTotal > 0) room.turnTracker?.gave?.add(senderId);

  // sets may appear for active after receiving
  checkSets(room, room.activePlayerId);
  checkSets(room, senderId);
  return { movedTotal, movedByType };
}

export function checkSets(room, playerId) {
  const p = room.players.get(playerId);
  if (!p) return;
  // find any type with >=4, possibly multiple
  let changed = false;
  for (let typeId=0; typeId<9; typeId++) {
    const cnt = p.handCounts.get(typeId) || 0;
    if (cnt >= 4) {
      const sets = Math.floor(cnt / 4);
      const remaining = cnt % 4;
      if (remaining === 0) p.handCounts.delete(typeId);
      else p.handCounts.set(typeId, remaining);

      p.setsCount += sets;
      const info = room.publicSets.get(playerId) || { setsCount: 0, byType: {} };
      info.setsCount += sets;
      info.byType[typeId] = (info.byType[typeId] || 0) + sets;
      room.publicSets.set(playerId, info);
      changed = true;
    }
  }
  if (changed) room.lastActivityAt = Date.now();
}

export function totalSetsInRoom(room) {
  let s = 0;
  for (const info of room.publicSets.values()) s += (info.setsCount || 0);
  return s;
}

export function advanceTurn(room) {
  room.turnIndex = (room.turnIndex + 1) % room.order.length;
  room.activePlayerId = room.order[room.turnIndex];
  startTurnTracker(room);
}

export function endTurn(room, rng=Math.random) {
  // penalty draw: if any eligible player did not give
  const tt = room.turnTracker;
  if (tt) {
    let penalty = false;
    for (const pid of tt.eligible) {
      if (!tt.gave.has(pid)) { penalty = true; break; }
    }
    if (penalty) drawOne(room, room.activePlayerId);
  }

  // sets after penalty
  checkSets(room, room.activePlayerId);

  // detect end of round AFTER we advance (if next is index 0)
  const wasIndex = room.turnIndex;
  advanceTurn(room);
  const newIndex = room.turnIndex;

  const roundEnded = (newIndex === 0); // we looped around
  if (roundEnded) {
    roundDraw(room, rng);
    // sets may appear for anyone after round draw
    for (const pid of room.order) checkSets(room, pid);
  }

  // finish?
  if (totalSetsInRoom(room) >= 9) {
    room.phase = "finished";
  }
}

export function roundDraw(room, rng=Math.random) {
  const pids = [...room.order];
  if (room.deck.length >= pids.length) {
    for (const pid of pids) drawOne(room, pid);
    return;
  }
  // random subset size = deck.length
  const k = room.deck.length;
  if (k <= 0) return;
  shuffleInPlace(pids, rng);
  const chosen = pids.slice(0, k);
  for (const pid of chosen) drawOne(room, pid);
}

export function makeSpinner() {
  const seed = Math.floor(Math.random() * 2**31);
  return { seed, durationMs: 2400 + Math.floor(Math.random() * 800) };
}

export function spinnerPickIndex(seed, nPlayers) {
  const rng = mulberry32(seed);
  return Math.floor(rng() * nPlayers);
}
