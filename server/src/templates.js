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
      const grid = JSON.parse(fs.readFileSync(gridPath, "utf-8"));
      templates.push({ id, name: meta.name, updatedAt: meta.updatedAt, grid });
    } catch {}
  }
  templates.sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));
  return templates;
}

export async function createTemplateFromUpload(filePath, originalName="template") {
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
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

  const grid = defaultGrid();
  fs.writeFileSync(path.join(dir, "grid.json"), JSON.stringify(grid, null, 2), "utf-8");

  const info = await sharp(sourcePath).metadata();
  return { id, width: info.width, height: info.height, grid };
}

export function defaultGrid() {
  return {
    // normalized 0..1
    x: [0.05, 0.35, 0.65, 0.95],
    y: [0.05, 0.35, 0.65, 0.95]
  };
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
  const grid = JSON.parse(fs.readFileSync(gridPath, "utf-8"));
  return { id, name: meta.name, meta, grid, sourcePath, slicesDir };
}

export function setTemplateGrid(id, grid) {
  const { gridPath, metaPath } = getTemplatePaths(id);
  if (!fs.existsSync(gridPath) || !fs.existsSync(metaPath)) return false;

  // Basic validation
  if (!grid || !Array.isArray(grid.x) || !Array.isArray(grid.y) || grid.x.length !== 4 || grid.y.length !== 4) return false;

  fs.writeFileSync(gridPath, JSON.stringify(grid, null, 2), "utf-8");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  meta.updatedAt = Date.now();
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  return true;
}

export async function sliceTemplate(id) {
  const t = loadTemplate(id);
  if (!t) throw new Error("template_not_found");
  const meta = await sharp(t.sourcePath).metadata();
  const W = meta.width, H = meta.height;
  if (!W || !H) throw new Error("bad_image");

  const xs = t.grid.x.map(v => Math.round(v * W));
  const ys = t.grid.y.map(v => Math.round(v * H));

  // Ensure ordering
  for (let i=1;i<4;i++) {
    if (xs[i] <= xs[i-1] + 5) xs[i] = xs[i-1] + 6;
    if (ys[i] <= ys[i-1] + 5) ys[i] = ys[i-1] + 6;
  }
  // Clamp to bounds
  xs[0] = Math.max(0, xs[0]); ys[0] = Math.max(0, ys[0]);
  xs[3] = Math.min(W, xs[3]); ys[3] = Math.min(H, ys[3]);

  // Write back normalized grid (in case of adjustments)
  const norm = { x: xs.map(v => v / W), y: ys.map(v => v / H) };
  setTemplateGrid(id, norm);

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
