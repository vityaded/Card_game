import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import sharp from "sharp";

const TEMPLATES_DIR = path.resolve("server/data/templates");

function ensureDirs() {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
}

function templateDir(id) { return path.join(TEMPLATES_DIR, id); }

export function listTemplates() {
  ensureDirs();
  const ids = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  const templates = [];
  for (const id of ids) {
    const metaPath = path.join(templateDir(id), "meta.json");
    const gridPath = path.join(templateDir(id), "grid.json");
    if (!fs.existsSync(metaPath) || !fs.existsSync(gridPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const rawGrid = JSON.parse(fs.readFileSync(gridPath, "utf-8"));
      const grid = gridObject(rawGrid);
      templates.push({ id, name: meta.name, status: meta.status || "ready", updatedAt: meta.updatedAt, grid });
    } catch {}
  }
  templates.sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));
  return templates;
}

export async function createTemplateDraft(filePath, originalName="template") {
  ensureDirs();
  const id = nanoid(10);
  const dir = templateDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "slices"), { recursive: true });

  const sourcePath = path.join(dir, "source.png");

  // Normalize to PNG for consistent slicing
  await sharp(filePath).png().toFile(sourcePath);

  const meta = {
    id,
    name: originalName,
    status: "draft",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

  const grid = gridObject(defaultGrid());
  fs.writeFileSync(path.join(dir, "grid.json"), JSON.stringify(grid, null, 2), "utf-8");

  const info = await sharp(sourcePath).metadata();
  return { templateId: id, width: info.width, height: info.height, defaultGrid: grid, imageUrl: `/api/templates/${id}/source` };
}

export async function createTemplateFromUpload(filePath, originalName="template") {
  const out = await createTemplateDraft(filePath, originalName);
  return { id: out.templateId, width: out.width, height: out.height, grid: normalizeGridArrays(out.defaultGrid) };
}

export function defaultGrid() {
  return {
    // normalized 0..1
    x0: 0.05, x1: 0.35, x2: 0.65, x3: 0.95,
    y0: 0.05, y1: 0.35, y2: 0.65, y3: 0.95
  };
}

function clamp01(v) { return Math.max(0, Math.min(1, Number(v))); }

function normalizeGridArrays(grid) {
  if (grid && Array.isArray(grid.x) && Array.isArray(grid.y) && grid.x.length === 4 && grid.y.length === 4) {
    return { x: grid.x.map(clamp01), y: grid.y.map(clamp01) };
  }
  const keys = ["x0","x1","x2","x3","y0","y1","y2","y3"];
  if (grid && keys.every(k => grid[k] !== undefined)) {
    return { x: [grid.x0, grid.x1, grid.x2, grid.x3].map(clamp01), y: [grid.y0, grid.y1, grid.y2, grid.y3].map(clamp01) };
  }
  return null;
}

function gridObject(grid) {
  const norm = normalizeGridArrays(grid) || normalizeGridArrays(defaultGrid());
  return { x0: norm.x[0], x1: norm.x[1], x2: norm.x[2], x3: norm.x[3], y0: norm.y[0], y1: norm.y[1], y2: norm.y[2], y3: norm.y[3] };
}

export function getTemplatePaths(id) {
  const dir = templateDir(id);
  return {
    dir,
    sourcePath: path.join(dir, "source.png"),
    gridPath: path.join(dir, "grid.json"),
    metaPath: path.join(dir, "meta.json"),
    slicesDir: path.join(dir, "slices")
  };
}

export function loadTemplate(id) {
  const { sourcePath, gridPath, metaPath, slicesDir } = getTemplatePaths(id);
  if (!fs.existsSync(sourcePath) || !fs.existsSync(gridPath) || !fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  const rawGrid = JSON.parse(fs.readFileSync(gridPath, "utf-8"));
  const grid = gridObject(rawGrid);
  return { id, name: meta.name, meta, grid, sourcePath, slicesDir };
}

export function setTemplateGrid(id, grid) {
  const { gridPath, metaPath } = getTemplatePaths(id);
  if (!fs.existsSync(gridPath) || !fs.existsSync(metaPath)) return false;

  // Basic validation
  if (!normalizeGridArrays(grid)) return false;

  fs.writeFileSync(gridPath, JSON.stringify(gridObject(grid), null, 2), "utf-8");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  meta.updatedAt = Date.now();
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  return true;
}

export async function finalizeTemplate(id, { name, grid }) {
  const { metaPath } = getTemplatePaths(id);
  if (!fs.existsSync(metaPath)) throw new Error("template_not_found");

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  const ok = setTemplateGrid(id, grid);
  if (!ok) throw new Error("invalid_grid");

  meta.name = String(name || meta.name || "Template");
  meta.status = "ready";
  meta.updatedAt = Date.now();
  if (!meta.createdAt) meta.createdAt = Date.now();
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  await sliceTemplate(id);
  return { ok: true };
}

export async function sliceTemplate(id) {
  const t = loadTemplate(id);
  if (!t) throw new Error("template_not_found");
  const meta = await sharp(t.sourcePath).metadata();
  const W = meta.width, H = meta.height;
  if (!W || !H) throw new Error("bad_image");

  const norm = normalizeGridArrays(t.grid);
  if (!norm) throw new Error("invalid_grid");

  const xs = norm.x.map(v => Math.round(v * W));
  const ys = norm.y.map(v => Math.round(v * H));

  // Ensure ordering
  for (let i=1;i<4;i++) {
    if (xs[i] <= xs[i-1] + 5) xs[i] = xs[i-1] + 6;
    if (ys[i] <= ys[i-1] + 5) ys[i] = ys[i-1] + 6;
  }
  // Clamp to bounds
  xs[0] = Math.max(0, xs[0]); ys[0] = Math.max(0, ys[0]);
  xs[3] = Math.min(W, xs[3]); ys[3] = Math.min(H, ys[3]);

  // Write back normalized grid (in case of adjustments)
  const normOut = { x: xs.map(v => v / W), y: ys.map(v => v / H) };
  setTemplateGrid(id, normOut);

  // 9 tiles in row-major order 0..8
  const tiles = [];
  for (let r=0;r<3;r++) {
    for (let c=0;c<3;c++) {
      const left = xs[c];
      const top = ys[r];
      const width = xs[c+1] - xs[c];
      const height = ys[r+1] - ys[r];
      tiles.push({ r,c,left,top,width,height });
    }
  }

  for (let i=0;i<tiles.length;i++) {
    const tile = tiles[i];
    const out = path.join(t.slicesDir, `${i}.png`);
    await sharp(t.sourcePath)
      .extract({ left: tile.left, top: tile.top, width: tile.width, height: tile.height })
      .png()
      .toFile(out);
  }

  return { ok: true };
}

export function renameTemplate(id, name) {
  const { metaPath } = getTemplatePaths(id);
  if (!fs.existsSync(metaPath)) return false;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  meta.name = String(name || "").slice(0, 80) || meta.name;
  meta.updatedAt = Date.now();
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  return true;
}

export function deleteTemplate(id) {
  const dir = templateDir(id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
