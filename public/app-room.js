const qs = new URLSearchParams(location.search);
const roomId = qs.get("roomId");
if (!roomId) alert("Missing roomId");

const socket = io();

function clientLog(obj){
  try {
    if (typeof window.__clientLog === "function") window.__clientLog(obj);
    else socket.emit("client_log", obj);
  } catch {}
}


const el = (id) => document.getElementById(id);
const storeKey = (k) => `cardgame:${roomId}:${k}`;

let me = { playerId: null, secret: null };
let snapshot = null;
let selected = new Set();
let lastSpinnerSeed = null;

function setText(id, txt) { el(id).textContent = txt; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function showJoin(show) {
  el("joinBox").classList.toggle("hidden", !show);
  el("gameBox").classList.toggle("hidden", show);
}

function getLocal() {
  return {
    playerId: localStorage.getItem(storeKey("playerId")),
    secret: localStorage.getItem(storeKey("secret"))
  };
}

function saveLocal(playerId, secret) {
  localStorage.setItem(storeKey("playerId"), playerId);
  localStorage.setItem(storeKey("secret"), secret);
}

function render(snapshot) {
  setText("roomBadge", `Room: ${snapshot.roomId}`);
  setText("phase", snapshot.phase);
  setText("deckCount", String(snapshot.deckCount ?? "-"));

  const activeName = snapshot.players.find(p => p.id === snapshot.activePlayerId)?.name || "-";
  setText("active", activeName);

  const askNextEl = el("askNext");
  if (askNextEl) {
    let askNextTxt = "";
    if (snapshot.phase === "active" && Array.isArray(snapshot.turnOrder) && snapshot.turnOrder.length > 0) {
      const idx = snapshot.turnOrder.indexOf(snapshot.activePlayerId);
      if (idx >= 0) {
        const nextId = snapshot.turnOrder[(idx + 1) % snapshot.turnOrder.length];
        const nextP = snapshot.players.find(p => p.id === nextId);
        if (nextP) askNextTxt = `Ask next: #${nextP.seat || "?"} ${nextP.name}`;
      }
    }
    askNextEl.textContent = askNextTxt;
    askNextEl.classList.toggle("hidden", !askNextTxt);
  }

  // Turn hint banner
  const hint = el("turnHint");
  if (hint) {
    const isActive = snapshot.phase === "active" && snapshot.activePlayerId === me.playerId;
    if (snapshot.phase === "lobby") {
      hint.className = "mt-3 p-3 rounded-2xl border text-center text-lg font-semibold bg-sky-50 border-sky-200";
      hint.textContent = "Waiting for host to start…";
      hint.classList.remove("hidden");
    } else if (snapshot.phase === "finished") {
      hint.className = "mt-3 p-3 rounded-2xl border text-center text-lg font-semibold bg-emerald-50 border-emerald-200";
      hint.textContent = "Game finished! 🎉";
      hint.classList.remove("hidden");
    } else if (isActive) {
      hint.className = "mt-3 p-3 rounded-2xl border text-center text-xl font-extrabold bg-amber-100 border-amber-300 animate-pulse";
      hint.textContent = "YOUR TURN! 👉 Ask in Zoom, then players give you cards";
      hint.classList.remove("hidden");
    } else {
      hint.className = "mt-3 p-3 rounded-2xl border text-center text-lg font-semibold bg-violet-50 border-violet-200";
      hint.textContent = `Waiting for ${activeName}…`;
      hint.classList.remove("hidden");
    }
  }

  
// Players list (with set thumbnails)
const wrap = el("players");
wrap.innerHTML = "";
const list = document.createElement("div");
list.className = "space-y-2";
const ps = snapshot.publicSets || {};

const playerList = [...snapshot.players].sort((a, b) => {
  const sa = a.seat ?? 999;
  const sb = b.seat ?? 999;
  if (sa === sb) return a.name.localeCompare(b.name);
  return sa - sb;
});

for (const p of playerList) {
  const isActive = p.id === snapshot.activePlayerId;
  const isMe = p.id === me.playerId;

  const info = ps[p.id] || {};
  const byType = info.byType || {};
  const thumbs = Object.keys(byType)
    .sort((a,b)=>Number(a)-Number(b))
    .map((typeId) => {
      const cnt = byType[typeId];
      if (!cnt) return "";
      return `
        <div class="relative">
          <img src="/api/templates/${snapshot.templateId}/slice/${Number(typeId)}" class="w-8 h-8 rounded-full border-2 border-white shadow object-cover" />
          ${cnt>1 ? `<div class="absolute -bottom-1 -right-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-900 text-white">×${cnt}</div>` : ``}
        </div>
      `;
    }).join("");

  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-3 border rounded-2xl px-3 py-2 bg-white/70 " + (isActive ? "ring-4 ring-amber-300" : "");
  row.innerHTML = `
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        ${p.seat ? `<span class="text-xs px-2 py-0.5 rounded-full bg-slate-900 text-white font-bold">#${p.seat}</span>` : ""}
        <div class="text-lg font-semibold truncate">${escapeHtml(p.name)} ${isMe ? "<span class='text-xs px-2 py-0.5 rounded-full bg-blue-600 text-white'>you</span>" : ""}</div>
        ${isActive ? "<div class='text-xs px-2 py-0.5 rounded-full bg-amber-400 text-slate-900 font-bold'>ACTIVE</div>" : ""}
      </div>
      <div class="mt-1 flex gap-1 flex-wrap">${thumbs || "<span class='text-xs text-slate-500'>(no sets)</span>"}</div>
    </div>
    <div class="text-right">
      <div class="text-sm font-mono">${p.handTotal} cards</div>
      <div class="text-sm font-mono">${p.setsCount} sets</div>
      <div class="text-xs text-slate-500">${p.online ? "online" : "offline"}</div>
    </div>
  `;
  list.appendChild(row);
}
wrap.appendChild(list);

  // Hand
  const handWrap = el("hand");
  handWrap.innerHTML = "";
  selected = new Set();
  const myHand = snapshot.me?.hand || {};
  const keys = Object.keys(myHand).sort((a,b)=>Number(a)-Number(b));
  if (keys.length === 0) {
    const empty = document.createElement("div");
    empty.className = "col-span-3 text-center p-6 rounded-2xl border-2 border-dashed bg-white/60 text-slate-600";
    empty.textContent = "No cards right now. You can still ask in Zoom and receive cards!";
    handWrap.appendChild(empty);
  }
  for (const k of keys) {
    const cnt = myHand[k];
    if (!cnt) continue;
    const typeId = Number(k);
    const card = document.createElement("button");
    card.className = "border-2 rounded-2xl overflow-hidden bg-white shadow hover:scale-[1.01] active:scale-[0.99] transition relative";
    card.innerHTML = `
      <div class="aspect-[3/4] bg-slate-100 flex items-center justify-center relative">
        <div class="selbadge hidden absolute top-2 left-2 px-2 py-1 rounded-full bg-blue-600 text-white text-xs font-bold shadow">Selected</div>
        <img src="/api/templates/${snapshot.templateId}/slice/${typeId}" alt="${typeId}" class="w-full h-full object-cover"/>
      </div>
      <div class="p-2 text-xs flex justify-between items-center">
        <span class="font-mono">#${typeId}</span>
        <span class="px-2 py-0.5 rounded bg-slate-800 text-white">×${cnt}</span>
      </div>
    `;
    card.addEventListener("click", () => {
      if (selected.has(typeId)) selected.delete(typeId);
      else selected.add(typeId);
      const on = selected.has(typeId);
      card.classList.toggle("ring-4", on);
      card.classList.toggle("ring-blue-500", on);
      card.querySelector(".selbadge")?.classList.toggle("hidden", !on);
    });
    handWrap.appendChild(card);
  }

  // Sets public
  const setsWrap = el("sets");
    // reuse ps from players list

  const lines = [];
  for (const p of snapshot.players) {
    const info = ps[p.id];
    const sc = info?.setsCount || 0;
    lines.push(`${escapeHtml(p.name)}: ${sc}`);
  }
  setsWrap.innerHTML = `<div class="grid grid-cols-2 gap-2">${lines.map(x=>`<div class="border rounded px-2 py-1">${x}</div>`).join("")}</div>`;

  // Buttons state
  const isMeActive = snapshot.activePlayerId === me.playerId && snapshot.phase === "active";
  el("btnEnd").disabled = !isMeActive;
  el("btnEnd").classList.toggle("opacity-50", !isMeActive);
  el("btnEnd").classList.toggle("cursor-not-allowed", !isMeActive);
  el("btnEnd").classList.toggle("animate-pulse", isMeActive);

  const canGive = snapshot.phase === "active" && snapshot.activePlayerId !== me.playerId;
  el("btnGive").disabled = !canGive;
  el("btnGive").classList.toggle("opacity-50", !canGive);
  el("btnGive").classList.toggle("cursor-not-allowed", !canGive);
}

function toast(html, variant="info") {
  const wrap = document.getElementById("toasts");
  if (!wrap) return;
  const div = document.createElement("div");
  const base = "px-4 py-3 rounded-2xl shadow-lg border bg-white/90 backdrop-blur text-slate-900";
  const v = variant === "success"
    ? "border-emerald-200"
    : variant === "warn"
      ? "border-amber-200"
      : "border-sky-200";
  div.className = base + " " + v;
  div.innerHTML = html;
  wrap.appendChild(div);
  setTimeout(() => div.classList.add("opacity-0", "translate-y-[-6px]", "transition", "duration-300"), 1800);
  setTimeout(() => div.remove(), 2200);
}

function popConfetti() {
  if (typeof window.confetti !== "function") return;
  window.confetti({ particleCount: 80, spread: 60, origin: { y: 0.65 } });
}

function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(()=>{});
  } catch {}
}

function playTurnSound() {
  ensureAudio();
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  // quick "bling": two tones with decay
  const o1 = audioCtx.createOscillator();
  const o2 = audioCtx.createOscillator();
  const g = audioCtx.createGain();

  o1.type = "sine";
  o2.type = "triangle";
  o1.frequency.setValueAtTime(880, t0);
  o2.frequency.setValueAtTime(1320, t0);

  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);

  o1.connect(g);
  o2.connect(g);
  g.connect(audioCtx.destination);

  o1.start(t0);
  o2.start(t0);
  o1.stop(t0 + 0.35);
  o2.stop(t0 + 0.35);
}

function showTurnOverlay() {
  const ov = document.getElementById("turnOverlay");
  if (!ov) return;
  ov.classList.remove("hidden");
  // wiggle the emoji
  const card = ov.querySelector("div.w-full");
  if (card) card.style.animation = "pop 0.5s ease-out, wiggle 0.6s ease-in-out 0.55s";
  const close = () => { ov.classList.add("hidden"); ov.removeEventListener("click", close); };
  ov.addEventListener("click", close);
  // auto close
  setTimeout(() => { if (!ov.classList.contains("hidden")) ov.classList.add("hidden"); }, 1800);
}


let prevPublicSets = {};
function detectSetEvents(nextSnapshot) {
  const ps = nextSnapshot.publicSets || {};
  const players = nextSnapshot.players || [];
  for (const p of players) {
    const pid = p.id;
    const nextInfo = ps[pid] || {};
    const nextBy = nextInfo.byType || {};
    const prevInfo = prevPublicSets[pid] || { setsCount: 0, byType: {} };
    const prevBy = prevInfo.byType || {};
    const nextSets = nextInfo.setsCount || 0;
    const prevSets = prevInfo.setsCount || 0;
    if (nextSets > prevSets) {
      const diffs = [];
      for (const k of Object.keys(nextBy)) {
        const a = nextBy[k] || 0;
        const b = prevBy[k] || 0;
        if (a > b) diffs.push({ typeId: Number(k), inc: a - b });
      }
      const thumbs = diffs.slice(0, 3).map(d => `
        <img src="/api/templates/${nextSnapshot.templateId}/slice/${d.typeId}" class="w-9 h-9 rounded-full border-2 border-white shadow object-cover" />
      `).join("");
      toast(`<div class="flex items-center gap-3"><div class="text-2xl">✨</div><div><div class="font-bold">${escapeHtml(p.name)} made a set!</div><div class="flex gap-1 mt-1">${thumbs}</div></div></div>`, "success");
      popConfetti();
    }
  }
  prevPublicSets = JSON.parse(JSON.stringify(ps || {}));
}

function showError(msg) {

  el("joinErr").textContent = msg;
}

el("btnJoin").addEventListener("click", () => {
  const name = el("name").value.trim();
  if (!name) return showError("Enter name");
  clientLog({ level:"info", message:"player_join_emit", roomId, name });
  socket.emit("player_join", { roomId, name });
});

el("btnGive").addEventListener("click", () => {
  if (!snapshot || snapshot.phase !== "active") return;
  if (snapshot.activePlayerId === me.playerId) return;
  const types = [...selected];
  if (types.length === 0) return alert("Select at least 1 type");
  socket.emit("give_to_active", { roomId, playerId: me.playerId, secret: me.secret, types });
});

el("btnEnd").addEventListener("click", () => {
  if (!snapshot || snapshot.phase !== "active") return;
  if (snapshot.activePlayerId !== me.playerId) return;
  socket.emit("end_turn", { roomId, playerId: me.playerId, secret: me.secret });
});

socket.on("joined", ({ playerId, secret, snapshot }) => {
  me.playerId = playerId;
  me.secret = secret;
  saveLocal(playerId, secret);
  showJoin(false);
  render(snapshot);
});

socket.on("resume_ok", ({ snapshot }) => {
  showJoin(false);
  render(snapshot);
});

socket.on("resume_fail", ({ reason }) => {
  console.warn("resume_fail", reason);
  // show join box
  showJoin(true);
});

socket.on("room_state", ({ snapshot: snap }) => {
  snapshot = snap;
  detectSetEvents(snap);
  render(snap);
});

socket.on("game_started", ({ spinner }) => {
  // show spinner animation on clients
  if (!spinner) return;
  lastSpinnerSeed = spinner.seed;
  startSpinner(spinner.seed, spinner.durationMs);
});

socket.on("game_finished", () => {
  alert("Game finished (all 9 sets collected).");
});

socket.on("error_msg", ({ error }) => {
  console.error(error);
  showError(error);
});

function startSpinner(seed, durationMs) {
  const bar = el("spinnerBar");
  const box = el("spinner");
  box.classList.remove("hidden");

  // Build pills for player order; we only have snapshot later; fallback to current players
  const names = (snapshot?.players || []).map(p => p.name);
  bar.innerHTML = "";
  const pills = names.map((n) => {
    const d = document.createElement("div");
    d.className = "px-2 py-1 rounded border text-xs";
    d.textContent = n;
    bar.appendChild(d);
    return d;
  });
  if (pills.length === 0) return;

  const steps = Math.max(12, Math.floor(durationMs / 120));
  let i = 0;
  const t0 = Date.now();
  const timer = setInterval(() => {
    for (const p of pills) p.classList.remove("bg-amber-200");
    pills[i % pills.length].classList.add("bg-amber-200");
    i++;
    if (Date.now() - t0 > durationMs) {
      clearInterval(timer);
      setTimeout(() => box.classList.add("hidden"), 800);
    }
  }, 120);
}

// Try resume on load
(() => {
  setText("roomBadge", `Room: ${roomId || "-"}`);
  const { playerId, secret } = getLocal();
  if (playerId && secret) {
    me.playerId = playerId; me.secret = secret;
    socket.emit("resume", { roomId, playerId, secret });
  } else {
    showJoin(true);
  }
})();
