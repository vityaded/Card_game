export class GridEditor {
  constructor(canvas, imageUrl, initialGrid) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.img = new Image();
    this.img.crossOrigin = "anonymous";
    this.grid = normalizeGrid(initialGrid);

    this.drag = null; // {kind, idx, axis}
    this.onChange = null;

    this.margin = 10; // pixels for hitbox
    this.minGap = 25; // min pixel gap between lines

    this.img.onload = () => {
      this.fitCanvas();
      this.render();
    };
    this.img.src = imageUrl;

    this.bind();
  }

  fitCanvas() {
    // set real pixel size to maintain image aspect
    const maxW = Math.min(900, this.canvas.parentElement.clientWidth);
    const aspect = this.img.height / this.img.width;
    const w = Math.max(320, maxW);
    const h = Math.round(w * aspect);
    this.canvas.width = w;
    this.canvas.height = h;
  }

  getGrid() {
    return {
      x: this.grid.x.map(v => clamp01(v)),
      y: this.grid.y.map(v => clamp01(v)),
    };
  }

  bind() {
    const c = this.canvas;
    const onDown = (e) => {
      const p = this.getPos(e);
      const hit = this.hitTest(p.x, p.y);
      if (hit) {
        this.drag = { ...hit };
        e.preventDefault();
      }
    };
    const onMove = (e) => {
      if (!this.drag) return;
      const p = this.getPos(e);
      this.moveLine(this.drag, p.x, p.y);
      this.render();
      this.onChange?.(this.getGrid());
      e.preventDefault();
    };
    const onUp = (e) => { this.drag = null; };

    c.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    // Touch
    c.addEventListener("touchstart", (e) => onDown(e.touches[0]), { passive: false });
    window.addEventListener("touchmove", (e) => onMove(e.touches[0]), { passive: false });
    window.addEventListener("touchend", onUp);
    window.addEventListener("resize", () => { this.fitCanvas(); this.render(); });
  }

  getPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
    return { x, y };
  }

  // 8 lines: x0,x1,x2,x3 and y0..y3, where x0/x3 outer, x1/x2 inner
  hitTest(x, y) {
    const xs = this.grid.x.map(v => v * this.canvas.width);
    const ys = this.grid.y.map(v => v * this.canvas.height);

    // vertical lines
    for (let i=0;i<4;i++) {
      if (Math.abs(x - xs[i]) <= this.margin) return { axis: "x", idx: i };
    }
    // horizontal
    for (let i=0;i<4;i++) {
      if (Math.abs(y - ys[i]) <= this.margin) return { axis: "y", idx: i };
    }
    return null;
  }

  moveLine(hit, x, y) {
    if (hit.axis === "x") {
      const px = clamp(x, 0, this.canvas.width);
      const v = px / this.canvas.width;
      this.grid.x[hit.idx] = v;
      this.enforceOrder("x");
    } else {
      const py = clamp(y, 0, this.canvas.height);
      const v = py / this.canvas.height;
      this.grid.y[hit.idx] = v;
      this.enforceOrder("y");
    }
  }

  enforceOrder(axis) {
    const arr = axis === "x" ? this.grid.x : this.grid.y;
    const max = 1;
    // clamp
    for (let i=0;i<4;i++) arr[i] = clamp01(arr[i]);

    // enforce increasing with minGap
    const gap = (axis === "x" ? this.minGap / this.canvas.width : this.minGap / this.canvas.height);

    // forward
    for (let i=1;i<4;i++) {
      if (arr[i] < arr[i-1] + gap) arr[i] = arr[i-1] + gap;
    }
    // backward (ensure last not beyond 1)
    if (arr[3] > max) arr[3] = max;
    for (let i=2;i>=0;i--) {
      if (arr[i] > arr[i+1] - gap) arr[i] = arr[i+1] - gap;
    }
    // clamp again
    for (let i=0;i<4;i++) arr[i] = clamp01(arr[i]);
  }

  render() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    ctx.clearRect(0,0,W,H);
    ctx.drawImage(this.img, 0,0,W,H);

    const xs = this.grid.x.map(v => v * W);
    const ys = this.grid.y.map(v => v * H);

    // Overlay shaded outside crop
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    // top
    ctx.fillRect(0, 0, W, ys[0]);
    // bottom
    ctx.fillRect(0, ys[3], W, H - ys[3]);
    // left
    ctx.fillRect(0, ys[0], xs[0], ys[3] - ys[0]);
    // right
    ctx.fillRect(xs[3], ys[0], W - xs[3], ys[3] - ys[0]);
    ctx.restore();

    // draw lines
    for (let i=0;i<4;i++) {
      drawV(ctx, xs[i], H, i===0||i===3);
      drawH(ctx, ys[i], W, i===0||i===3);
    }

    // draw tile indices (0..8) in each cell
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.font = "14px sans-serif";
    let idx = 0;
    for (let r=0;r<3;r++) {
      for (let c=0;c<3;c++) {
        const left = xs[c], right = xs[c+1];
        const top = ys[r], bottom = ys[r+1];
        const cx = (left+right)/2, cy=(top+bottom)/2;
        const label = String(idx++);
        ctx.beginPath();
        ctx.roundRect(cx-14, cy-12, 28, 24, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "rgba(0,0,0,0.8)";
        ctx.fillText(label, cx-4, cy+5);
        ctx.fillStyle = "rgba(255,255,255,0.85)";
      }
    }
    ctx.restore();
  }
}

function drawV(ctx, x, H, outer) {
  ctx.save();
  ctx.strokeStyle = outer ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.8)";
  ctx.lineWidth = outer ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(x,0); ctx.lineTo(x,H);
  ctx.stroke();

  // shadow
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x+1,0); ctx.lineTo(x+1,H);
  ctx.stroke();
  ctx.restore();
}

function drawH(ctx, y, W, outer) {
  ctx.save();
  ctx.strokeStyle = outer ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.8)";
  ctx.lineWidth = outer ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(0,y); ctx.lineTo(W,y);
  ctx.stroke();

  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0,y+1); ctx.lineTo(W,y+1);
  ctx.stroke();
  ctx.restore();
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function clamp01(v) { return clamp(v, 0.0, 1.0); }

function normalizeGrid(g) {
  if (!g || !Array.isArray(g.x) || !Array.isArray(g.y) || g.x.length!==4 || g.y.length!==4) {
    return { x:[0.05,0.35,0.65,0.95], y:[0.05,0.35,0.65,0.95] };
  }
  return { x:[...g.x], y:[...g.y] };
}
