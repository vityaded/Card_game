import { GridEditor } from "./ui-grid-editor.js";

const qs = new URLSearchParams(location.search);
let roomId = qs.get("roomId") || null;

const socket = io();

const el = (id) => document.getElementById(id);

let selectedTemplateId = null;
let editor = null;
let roomSnapshot = null;

const draft = {
  templateId: null,
  imageReady: false,
  gridReady: false,
  file: null,
};

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

function setStatus(msg) {
  const n = el("uploadStatus");
  if (n) n.textContent = msg;
}

function absUrl(rel) {
  return `${location.origin}${rel}`;
}

function toast(msg) {
  let wrap = document.getElementById("toasts");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toasts";
    wrap.className = "fixed top-3 left-1/2 -translate-x-1/2 z-50 space-y-2";
    document.body.appendChild(wrap);
  }
  const div = document.createElement("div");
  div.className = "px-4 py-2 rounded-2xl shadow-lg border bg-white/90 backdrop-blur text-slate-900 text-sm";
  div.textContent = msg;
  wrap.appendChild(div);
  setTimeout(() => div.classList.add("opacity-0","translate-y-[-6px]","transition","duration-300"), 900);
  setTimeout(() => div.remove(), 1200);
}

async function copyToClipboard(text) {
  // must be called from a user gesture (button click)
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // fallback for http / non-secure contexts
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
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
async function apiUpload(url, file) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(url, { method: "POST", body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "upload_failed");
  return j;
}
async function apiCreateTemplateDraft(file) {
  return apiUpload("/api/templates/draft", file);
}
async function apiFinalizeTemplate({ templateId, name, grid }) {
  return apiPost(`/api/templates/${templateId}/finalize`, { name, grid });
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
      const playerUrlFull = `${location.origin}${playerUrl}`;
      rows.push(`
        <div class="border rounded-2xl p-2 bg-white/70 flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="font-semibold">${id}</div>
            <div class="text-xs text-slate-600">${j.phase} · players ${j.playersCount} · active ${escapeHtml(j.activeName||'-')}</div>
            <div class="text-xs text-slate-600 truncate">${playerUrlFull}</div>
          </div>
          <div class="flex gap-2 shrink-0">
            <button
              class="px-3 py-2 rounded-2xl bg-amber-400 text-slate-900 shadow text-sm"
              data-copy="${playerUrlFull}"
            >
              Copy link
            </button>
            <a class="px-3 py-2 rounded-2xl bg-blue-600 text-white shadow text-sm" href="${hostUrl}">Open</a>
          </div>
        </div>
      `);
    } catch {}
  }
  saveMyRooms(keep);
  wrap.innerHTML = rows.join("") || '<div class="text-slate-500">(no active rooms)</div>';

  wrap.querySelectorAll("button[data-copy]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = btn.dataset.copy;
      try {
        const ok = await copyToClipboard(url);
        toast(ok ? "Copied link ✅" : "Copy failed ❌");
      } catch {
        toast("Copy failed ❌");
      }
    });
  });
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

function makeDefaultGrid() {
  return { x0: 0.05, x1: 0.35, x2: 0.65, x3: 0.95, y0: 0.05, y1: 0.35, y2: 0.65, y3: 0.95 };
}

function gridForEditor(grid) {
  if (grid && Array.isArray(grid.x) && Array.isArray(grid.y)) return grid;
  if (grid && ["x0","x1","x2","x3","y0","y1","y2","y3"].every(k => grid[k] !== undefined)) {
    return { x: [grid.x0, grid.x1, grid.x2, grid.x3], y: [grid.y0, grid.y1, grid.y2, grid.y3] };
  }
  const g = makeDefaultGrid();
  return { x: [g.x0,g.x1,g.x2,g.x3], y: [g.y0,g.y1,g.y2,g.y3] };
}

function gridPayload(grid) {
  if (!grid || !Array.isArray(grid.x) || !Array.isArray(grid.y)) return makeDefaultGrid();
  return { x0: grid.x[0], x1: grid.x[1], x2: grid.x[2], x3: grid.x[3], y0: grid.y[0], y1: grid.y[1], y2: grid.y[2], y3: grid.y[3] };
}

function updateConfirmEnabled() {
  const ok = !!draft.templateId && draft.imageReady && draft.gridReady && (el("templateName").value.trim().length > 0);
  el("btnConfirmTemplate").disabled = !ok;
}

function resetDraftState() {
  draft.templateId = null;
  draft.imageReady = false;
  draft.gridReady = false;
  draft.file = null;
  el("gridEditorWrap").classList.add("hidden");
  el("slicesPreviewWrap").classList.add("hidden");
  el("slicePreview").innerHTML = "";
  updateConfirmEnabled();
}

function showGridEditor(imageUrl, initialGrid) {
  const canvas = el("gridCanvas");
  const grid = gridForEditor(initialGrid);
  editor = new GridEditor(canvas, imageUrl, grid);
  editor.onChange = () => {
    draft.gridReady = true;
    updateConfirmEnabled();
  };
  draft.gridReady = true;
  el("gridEditorWrap").classList.remove("hidden");
}

function showSlicesPreview(templateId) {
  renderSlices(templateId);
  el("slicesPreviewWrap").classList.remove("hidden");
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

const playerList = [...snapshot.players].sort((a, b) => {
  const sa = a.seat ?? 999;
  const sb = b.seat ?? 999;
  if (sa === sb) return a.name.localeCompare(b.name);
  return sa - sb;
});

for (const p of playerList) {
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
        ${p.seat ? `<span class="text-xs px-2 py-0.5 rounded-full bg-slate-900 text-white font-bold">#${p.seat}</span>` : ""}
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
  try {
    const ok = await copyToClipboard(txt);
    toast(ok ? "Copied link ✅" : "Copy failed ❌");
  } catch {
    toast("Copy failed ❌");
  }
});

el("btnCreate").addEventListener("click", async () => {
  const j = await apiGet("/api/rooms/create");
  roomId = j.roomId;
  addMyRoom(roomId);
  history.replaceState({}, "", `/host.html?roomId=${roomId}`);
  await ensureRoom();
});

el("btnRefreshTemplates").addEventListener("click", refreshTemplates);

el("templateName").addEventListener("input", updateConfirmEnabled);

el("fileInput").addEventListener("change", async () => {
  const f = el("fileInput").files?.[0];
  if (!f) return;

  draft.file = f;
  draft.templateId = null;
  draft.imageReady = false;
  draft.gridReady = false;
  el("slicesPreviewWrap").classList.add("hidden");
  updateConfirmEnabled();

  if (!el("templateName").value.trim()) {
    const base = f.name.replace(/\.[^.]+$/, "");
    el("templateName").value = base;
  }

  setStatus("Uploading...");
  el("btnConfirmTemplate").disabled = true;
  try {
    const j = await apiCreateTemplateDraft(f);
    draft.templateId = j.templateId || j.id;
    draft.imageReady = true;

    const imgUrl = j.imageUrl || `/api/templates/${draft.templateId}/source?t=${Date.now()}`;
    showGridEditor(imgUrl, j.defaultGrid || makeDefaultGrid());
    setStatus("Adjust grid, then Confirm");
    updateConfirmEnabled();
  } catch (e) {
    console.error(e);
    setStatus("Choose an image…");
    alert(e?.message || "upload_failed");
    resetDraftState();
  }
});

el("btnConfirmTemplate").addEventListener("click", async () => {
  if (el("btnConfirmTemplate").disabled) return;
  if (!editor || !draft.templateId) return;
  setStatus("Saving...");
  el("btnConfirmTemplate").disabled = true;
  const name = el("templateName").value.trim();
  const grid = gridPayload(editor.getGrid());
  try {
    await apiFinalizeTemplate({ templateId: draft.templateId, name, grid });
    selectedTemplateId = draft.templateId;
    setText("selectedTpl", selectedTemplateId);
    showSlicesPreview(draft.templateId);
    toast("Saved ✅");
    setStatus("Saved ✅");
    await refreshTemplates();
  } catch (e) {
    console.error(e);
    setStatus("Adjust grid, then Confirm");
    alert(e?.message || "save_failed");
  } finally {
    updateConfirmEnabled();
  }
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

setStatus("Choose an image…");
updateConfirmEnabled();

await ensureRoom();
await refreshTemplates();
await renderMyRooms();
setInterval(() => renderMyRooms().catch(()=>{}), 2500);
