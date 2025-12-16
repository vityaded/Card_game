import { GridEditor } from "./ui-grid-editor.js";

const qs = new URLSearchParams(location.search);
let roomId = qs.get("roomId") || null;

const socket = io();

const el = (id) => document.getElementById(id);

let selectedTemplateId = null;
let currentTemplateId = null;
let editor = null;
let roomSnapshot = null;

const myRoomsKey = "cardgame:myRooms";
function loadMyRooms(){
  try { return JSON.parse(localStorage.getItem(myRoomsKey) || "[]"); } catch { return []; }
}
function saveMyRooms(arr){ localStorage.setItem(myRoomsKey, JSON.stringify(arr)); }
function addMyRoom(id){
  const arr = loadMyRooms();
  if (!arr.includes(id)) { arr.unshift(id); saveMyRooms(arr.slice(0, 30)); }
}


function setText(id, txt) { el(id).textContent = txt; }

function absUrl(rel) {
  return `${location.origin}${rel}`;
}

async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}
async function apiPost(url, data) {
  const r = await fetch(url, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(data) });
  const j = await r.json();
  if (!j.ok && j.ok !== undefined) throw new Error(j.error || "error");
  return j;
}
async function apiDelete(url) {
  const r = await fetch(url, { method: "DELETE" });
  const j = await r.json();
  if (!j.ok) throw new Error("delete_failed");
  return j;
}

function renderTemplates(list) {
  const wrap = el("templatesList");
  wrap.innerHTML = "";
  for (const t of list) {
    const row = document.createElement("div");
    row.className = "border rounded p-2 flex items-center justify-between gap-2";
    row.innerHTML = `
      <div class="min-w-0">
        <div class="font-medium truncate">${escapeHtml(t.name)}</div>
        <div class="text-xs text-slate-500 font-mono">${t.id}</div>
      </div>
      <div class="flex gap-2 shrink-0">
        <button data-act="select" data-id="${t.id}" class="px-2 py-1 rounded bg-slate-800 text-white text-xs">Select</button>
        <button data-act="rename" data-id="${t.id}" class="px-2 py-1 rounded bg-blue-600 text-white text-xs">Rename</button>
        <button data-act="delete" data-id="${t.id}" class="px-2 py-1 rounded bg-rose-600 text-white text-xs">Delete</button>
      </div>
    `;
    wrap.appendChild(row);
  }

  wrap.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if (act === "select") {
        selectedTemplateId = id;
        setText("selectedTpl", id);
      } else if (act === "rename") {
        const name = prompt("New name:");
        if (!name) return;
        await apiPost(`/api/templates/${id}/rename`, { name });
        await refreshTemplates();
      } else if (act === "delete") {
        if (!confirm("Delete template?")) return;
        await apiDelete(`/api/templates/${id}`);
        if (selectedTemplateId === id) selectedTemplateId = null;
        await refreshTemplates();
      }
    });
  });
}

async function renderMyRooms(){
  const wrap = el("myRooms");
  if (!wrap) return;
  const ids = loadMyRooms();
  if (ids.length === 0) { wrap.innerHTML = '<div class="text-slate-500">(no rooms yet)</div>'; return; }
  const rows = [];
  const keep = [];
  for (const id of ids) {
    try {
      const j = await apiGet(`/api/rooms/${id}/summary`);
      if (!j.exists) continue;
      keep.push(id);
      const hostUrl = `/host.html?roomId=${id}`;
      const playerUrl = `/room.html?roomId=${id}`;
      rows.push(`
        <div class="border rounded-2xl p-2 bg-white/70 flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="font-semibold">${id}</div>
            <div class="text-xs text-slate-600">${j.phase} · players ${j.playersCount} · active ${escapeHtml(j.activeName||'-')}</div>
            <div class="text-xs text-slate-600 truncate">${location.origin}${playerUrl}</div>
          </div>
          <div class="flex gap-2 shrink-0">
            <a class="px-3 py-2 rounded-2xl bg-blue-600 text-white shadow text-sm" href="${hostUrl}">Open</a>
          </div>
        </div>
      `);
    } catch {}
  }
  saveMyRooms(keep);
  wrap.innerHTML = rows.join("") || '<div class="text-slate-500">(no active rooms)</div>';
}

async function refreshTemplates() {

  const j = await apiGet("/api/templates");
  renderTemplates(j.templates);
}

function renderSlices(templateId) {
  const wrap = el("slicePreview");
  wrap.innerHTML = "";
  for (let i=0;i<9;i++) {
    const img = document.createElement("img");
    img.className = "w-full h-auto rounded border bg-slate-100";
    img.alt = String(i);
    img.src = `/api/templates/${templateId}/slice/${i}?t=${Date.now()}`;
    wrap.appendChild(img);
  }
}

function renderRoom(snapshot) {
  roomSnapshot = snapshot;
  setText("phase", snapshot.phase);
  setText("deckCount", String(snapshot.deckCount ?? "-"));

  const activeName = snapshot.players.find(p => p.id === snapshot.activePlayerId)?.name || "-";
  setText("active", activeName);

  
// Players list (cards + set thumbnails)
const pt = el("playersTable");
pt.innerHTML = "";
const ps = snapshot.publicSets || {};
const list = document.createElement("div");
list.className = "space-y-2";

for (const p of snapshot.players) {
  const isActive = p.id === snapshot.activePlayerId;
  const info = ps[p.id] || {};
  const byType = info.byType || {};
  const thumbs = Object.keys(byType)
    .sort((a,b)=>Number(a)-Number(b))
    .map((typeId) => {
      const cnt = byType[typeId];
      if (!cnt) return "";
      return `
        <div class="relative">
          <img src="/api/templates/${snapshot.templateId}/slice/${Number(typeId)}" class="w-8 h-8 rounded-full border-2 border-white shadow object-cover"/>
          ${cnt>1 ? `<div class="absolute -bottom-1 -right-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-900 text-white">×${cnt}</div>` : ``}
        </div>
      `;
    }).join("");

  const row = document.createElement("div");
  row.className = "border rounded-2xl p-3 bg-white/70 flex items-center justify-between gap-3 " + (isActive ? "ring-4 ring-amber-300" : "");
  row.innerHTML = `
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <div class="font-semibold text-lg truncate">${escapeHtml(p.name)}</div>
        ${isActive ? "<span class='text-xs px-2 py-0.5 rounded-full bg-amber-400 text-slate-900 font-bold'>ACTIVE</span>" : ""}
        ${p.online ? "" : "<span class='text-xs text-slate-400'>(offline)</span>"}
      </div>
      <div class="mt-2 flex gap-1 flex-wrap">${thumbs || "<span class='text-xs text-slate-500'>(no sets)</span>"}</div>
      <div class="text-xs text-slate-600 mt-1">Cards: <span class="font-mono">${p.handTotal}</span> · Sets: <span class="font-mono">${p.setsCount}</span></div>
    </div>
    <div class="text-right">
      <button data-remove="${p.id}" class="px-3 py-2 rounded-2xl bg-rose-600 text-white text-sm shadow">Remove</button>
    </div>
  `;
  list.appendChild(row);
}
pt.appendChild(list);

pt.querySelectorAll("button[data-remove]").forEach(btn => {
  btn.addEventListener("click", () => {
    const pid = btn.dataset.remove;
    if (!confirm("Remove player and return cards to deck?")) return;
    socket.emit("host_remove_player", { roomId, playerId: pid });
  });
});

  pt.querySelectorAll("button[data-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      const pid = btn.dataset.remove;
      if (!confirm("Remove player and return cards to deck?")) return;
      socket.emit("host_remove_player", { roomId, playerId: pid });
    });
  });

  // Hands view
  const hv = el("handsView");
  hv.innerHTML = "";
  for (const p of snapshot.players) {
    const box = document.createElement("div");
    box.className = "border rounded p-2";
    const handEntries = Object.entries(p.hand || {});
    const handStr = handEntries.length
      ? handEntries.map(([k,v]) => `#${k}×${v}`).join(", ")
      : "(empty)";
    box.innerHTML = `<div class="font-medium">${escapeHtml(p.name)}</div><div class="text-xs font-mono">${handStr}</div>`;
    hv.appendChild(box);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

async function ensureRoom() {
  if (!roomId) {
    const j = await apiGet("/api/rooms/create");
    roomId = j.roomId;
  addMyRoom(roomId);
    history.replaceState({}, "", `/host.html?roomId=${roomId}`);
  }
  addMyRoom(roomId);
  setText("roomBadge", `Room: ${roomId}`);
  const playerUrl = `/room.html?roomId=${roomId}`;
  el("playerLink").innerHTML = `<a class="underline text-blue-700" href="${playerUrl}" target="_blank">${absUrl(playerUrl)}</a>`;
  socket.emit("host_join", { roomId });
}

el("btnCopyLink").addEventListener("click", async () => {
  const a = el("playerLink")?.querySelector("a");
  const txt = a ? a.href : "";
  if (!txt) return;
  try { await navigator.clipboard.writeText(txt); alert("Copied!"); } catch { prompt("Copy link:", txt); }
});

el("btnCreate").addEventListener("click", async () => {
  const j = await apiGet("/api/rooms/create");
  roomId = j.roomId;
  addMyRoom(roomId);
  history.replaceState({}, "", `/host.html?roomId=${roomId}`);
  await ensureRoom();
});

el("btnRefreshTemplates").addEventListener("click", refreshTemplates);

el("btnUpload").addEventListener("click", async () => {
  if (!roomId) await ensureRoom();
  const file = el("tplFile").files?.[0];
  if (!file) return alert("Choose a file");
  const name = el("tplName").value || file.name;

  const fd = new FormData();
  fd.append("file", file);
  fd.append("name", name);

  const r = await fetch("/api/templates/upload", { method: "POST", body: fd });
  const j = await r.json();
  if (!j.ok) return alert(j.error || "upload failed");
  currentTemplateId = j.id;
  selectedTemplateId = j.id;
  setText("selectedTpl", selectedTemplateId);
  el("editorWrap").classList.remove("hidden");
  setText("tplStatus", `Template ${j.id} uploaded (${j.width}×${j.height})`);

  const imgUrl = `/api/templates/${j.id}/source?t=${Date.now()}`;
  const canvas = el("gridCanvas");
  editor = new GridEditor(canvas, imgUrl, j.grid);
  editor.onChange = (grid) => {
    // optional live status
  };

  await refreshTemplates();
});

el("btnSaveGrid").addEventListener("click", async () => {
  if (!currentTemplateId || !editor) return;
  const grid = editor.getGrid();
  await apiPost(`/api/templates/${currentTemplateId}/grid`, { grid });
  setText("tplStatus", "Grid saved");
  await refreshTemplates();
});

el("btnSlice").addEventListener("click", async () => {
  if (!currentTemplateId) return;
  setText("tplStatus", "Slicing...");
  await apiPost(`/api/templates/${currentTemplateId}/slice`, {});
  setText("tplStatus", "Sliced 9 cards");
  renderSlices(currentTemplateId);
  await refreshTemplates();
});

el("btnStart").addEventListener("click", async () => {
  if (!selectedTemplateId) return alert("Select template first");
  socket.emit("game_start", { roomId, templateId: selectedTemplateId });
});

el("btnNewGame").addEventListener("click", () => {
  socket.emit("game_new", { roomId });
});

socket.on("room_state", ({ snapshot }) => {
  // host always gets host snapshot
  renderRoom(snapshot);
});

socket.on("game_started", ({ spinner }) => {
  // host can ignore spinner
});

socket.on("error_msg", ({ error }) => {
  console.error(error);
  alert(error);
});

await ensureRoom();
await refreshTemplates();
await renderMyRooms();
setInterval(() => renderMyRooms().catch(()=>{}), 2500);
