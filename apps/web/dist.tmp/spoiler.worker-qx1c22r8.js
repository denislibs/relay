// packages/relay-ui/src/spoilerSim.js
var TILE_W = 160;
var TILE_H = 64;
function createSim(canvas, dpr) {
  var ctx = canvas.getContext("2d");
  canvas.width = Math.round(TILE_W * dpr);
  canvas.height = Math.round(TILE_H * dpr);
  var { width: W, height: H } = canvas;
  var N = 520, seed = 12345;
  function rnd() {
    seed = seed * 16807 % 2147483647;
    return (seed - 1) / 2147483646;
  }
  var px = new Float32Array(N), py = new Float32Array(N), life = new Float32Array(N), span = new Float32Array(N), size = new Float32Array(N);
  function spawn(i, t0) {
    px[i] = rnd() * W;
    py[i] = rnd() * H;
    span[i] = 0.9 + rnd() * 1.8;
    life[i] = t0 ? rnd() * span[i] : 0;
    size[i] = (0.55 + rnd() * 0.5) * dpr;
  }
  for (var i = 0;i < N; i++)
    spawn(i, true);
  var t = 0;
  var speed = 9 * dpr;
  function step(dt) {
    t += dt;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    for (var i = 0;i < N; i++) {
      life[i] += dt;
      if (life[i] >= span[i])
        spawn(i, false);
      var a = Math.sin(px[i] * 0.021 / dpr + t * 0.7) * 2.1 + Math.cos(py[i] * 0.043 / dpr - t * 0.5) * 1.7 + i * 0.37;
      px[i] += Math.cos(a) * speed * dt;
      py[i] += Math.sin(a) * speed * dt;
      if (px[i] < 0)
        px[i] += W;
      else if (px[i] >= W)
        px[i] -= W;
      if (py[i] < 0)
        py[i] += H;
      else if (py[i] >= H)
        py[i] -= H;
      var k = life[i] / span[i];
      ctx.globalAlpha = Math.sin(Math.PI * k) * 0.95;
      var s = size[i];
      ctx.fillRect(px[i] - s / 2, py[i] - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }
  return { canvas, step };
}
function drawOverlay(ctx, tile, o, dpr) {
  var w = ctx.canvas.width, hgt = ctx.canvas.height;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, w, hgt);
  if (!o.rects.length)
    return;
  o.pattern = ctx.createPattern(tile, "repeat");
  if (o.pattern && o.pattern.setTransform && typeof DOMMatrix !== "undefined")
    o.pattern.setTransform(new DOMMatrix().translateSelf(o.ox, o.oy));
  ctx.save();
  ctx.beginPath();
  for (var i = 0;i < o.rects.length; i++) {
    var r = o.rects[i];
    ctx.rect(r[0] * dpr, r[1] * dpr, r[2] * dpr, r[3] * dpr);
  }
  ctx.clip();
  ctx.fillStyle = o.pattern;
  ctx.fillRect(0, 0, w, hgt);
  ctx.restore();
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = o.color;
  ctx.fillRect(0, 0, w, hgt);
  if (o.reveal) {
    var rv = o.reveal, R = rv.r * dpr, x = rv.x * dpr, y = rv.y * dpr, edge = 14 * dpr;
    ctx.globalCompositeOperation = "destination-out";
    var g = ctx.createRadialGradient(x, y, Math.max(0, R - edge), x, y, R + 0.01);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, R + 0.01, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.globalCompositeOperation = "source-over";
}

// packages/relay-ui/src/spoiler.worker.js
var FRAME_MS = 1000 / 30;
var sims = {};
var overlays = new Map;
var timer = null;
var last = 0;
function simFor(dpr) {
  var k = String(dpr);
  if (!sims[k])
    sims[k] = createSim(new OffscreenCanvas(1, 1), dpr);
  return sims[k];
}
function frame() {
  timer = null;
  var now = performance.now(), dt = Math.min(0.1, (now - last) / 1000 || FRAME_MS / 1000);
  last = now;
  var stepped = {};
  var any = false;
  overlays.forEach(function(o, id) {
    if (!o.playing && !o.reveal)
      return;
    any = true;
    var k = String(o.dpr);
    if (!stepped[k]) {
      simFor(o.dpr).step(dt);
      stepped[k] = true;
    }
    if (o.reveal) {
      var p = Math.min(1, (now - o.reveal.start) / o.reveal.duration);
      o.reveal.r = o.reveal.maxDist * (p * p);
      if (p >= 1) {
        o.ctx.clearRect(0, 0, o.canvas.width, o.canvas.height);
        overlays.delete(id);
        return;
      }
    }
    drawOverlay(o.ctx, simFor(o.dpr).canvas, o, o.dpr);
    if (!o.drawn) {
      o.drawn = true;
      postMessage({ type: "drawn", id });
    }
  });
  if (any)
    schedule();
}
function schedule() {
  if (timer == null)
    timer = setTimeout(frame, FRAME_MS);
}
onmessage = function(e) {
  var m = e.data, o = overlays.get(m.id);
  switch (m.type) {
    case "attach": {
      var ctx = m.canvas.getContext("2d");
      m.canvas.width = Math.max(1, Math.round(m.w * m.dpr));
      m.canvas.height = Math.max(1, Math.round(m.h * m.dpr));
      overlays.set(m.id, {
        canvas: m.canvas,
        ctx,
        dpr: m.dpr,
        rects: m.rects,
        color: m.color,
        playing: m.playing !== false,
        reveal: null,
        drawn: false,
        ox: Math.random() * 160,
        oy: Math.random() * 64,
        pattern: null,
        patternTile: null
      });
      last = last || performance.now();
      schedule();
      return;
    }
    case "update":
      if (!o)
        return;
      var W = Math.max(1, Math.round(m.w * o.dpr)), H = Math.max(1, Math.round(m.h * o.dpr));
      if (o.canvas.width !== W || o.canvas.height !== H) {
        o.canvas.width = W;
        o.canvas.height = H;
        o.pattern = null;
      }
      o.rects = m.rects;
      o.color = m.color;
      schedule();
      return;
    case "play":
      if (o) {
        o.playing = true;
        schedule();
      }
      return;
    case "pause":
      if (o)
        o.playing = false;
      return;
    case "reveal":
      if (!o)
        return;
      o.reveal = { x: m.x, y: m.y, maxDist: m.maxDist, duration: m.duration, start: performance.now(), r: 0 };
      schedule();
      return;
    case "detach":
      overlays.delete(m.id);
      return;
  }
};

//# debugId=2DCE8FE89307750C64756E2164756E21
//# sourceMappingURL=spoiler.worker-qx1c22r8.js.map
