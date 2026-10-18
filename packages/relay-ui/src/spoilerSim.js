// Частицы спойлера: одна бесшовная плитка (повторяется узором), частицы дрейфуют по плавному полю,
// рождаются и гаснут. Рисуется белым с альфой — цвет текста накладывает тот, кто рисует узор.
// Работает и в воркере (OffscreenCanvas), и в окне.

export var TILE_W = 160, TILE_H = 64;   // CSS px

export function createSim(canvas, dpr) {
  var ctx = canvas.getContext('2d');
  canvas.width = Math.round(TILE_W * dpr);
  canvas.height = Math.round(TILE_H * dpr);
  var W = canvas.width, H = canvas.height;
  var N = 520, seed = 12345;
  function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
  var px = new Float32Array(N), py = new Float32Array(N), life = new Float32Array(N), span = new Float32Array(N), size = new Float32Array(N);
  function spawn(i, t0) {
    px[i] = rnd() * W; py[i] = rnd() * H;
    span[i] = 0.9 + rnd() * 1.8;            // секунд жизни
    life[i] = t0 ? rnd() * span[i] : 0;     // при старте — вразнобой, без общей вспышки
    size[i] = (0.55 + rnd() * 0.5) * dpr;
  }
  for (var i = 0; i < N; i++) spawn(i, true);
  var t = 0;
  var speed = 9 * dpr;   // px/с

  /** Шаг симуляции на dt секунд и отрисовка плитки. */
  function step(dt) {
    t += dt;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    for (var i = 0; i < N; i++) {
      life[i] += dt;
      if (life[i] >= span[i]) spawn(i, false);
      // направление — гладкое поле от координат и времени: соседние частицы текут похоже, как дымка
      var a = Math.sin(px[i] * 0.021 / dpr + t * 0.7) * 2.1 + Math.cos(py[i] * 0.043 / dpr - t * 0.5) * 1.7 + i * 0.37;
      px[i] += Math.cos(a) * speed * dt;
      py[i] += Math.sin(a) * speed * dt;
      if (px[i] < 0) px[i] += W; else if (px[i] >= W) px[i] -= W;   // плитка бесшовная
      if (py[i] < 0) py[i] += H; else if (py[i] >= H) py[i] -= H;
      var k = life[i] / span[i];
      ctx.globalAlpha = Math.sin(Math.PI * k) * 0.95;
      var s = size[i];
      ctx.fillRect(px[i] - s / 2, py[i] - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }
  return { canvas: canvas, step: step };
}

/**
 * Кадр одного наложения: узор из плитки в прямоугольниках спойлеров, окрашенный в color;
 * reveal — дыра-круг (cx, cy, r) с мягким краем.
 */
export function drawOverlay(ctx, tile, o, dpr) {
  var w = ctx.canvas.width, hgt = ctx.canvas.height;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, hgt);
  if (!o.rects.length) return;
  // узор — снимок плитки на момент createPattern: кэшировать нельзя, иначе частицы застывают на первом кадре
  o.pattern = ctx.createPattern(tile, 'repeat');
  if (o.pattern && o.pattern.setTransform && typeof DOMMatrix !== 'undefined') o.pattern.setTransform(new DOMMatrix().translateSelf(o.ox, o.oy));
  ctx.save();
  ctx.beginPath();
  for (var i = 0; i < o.rects.length; i++) { var r = o.rects[i]; ctx.rect(r[0] * dpr, r[1] * dpr, r[2] * dpr, r[3] * dpr); }
  ctx.clip();
  ctx.fillStyle = o.pattern;
  ctx.fillRect(0, 0, w, hgt);
  ctx.restore();
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = o.color;
  ctx.fillRect(0, 0, w, hgt);
  if (o.reveal) {
    var rv = o.reveal, R = rv.r * dpr, x = rv.x * dpr, y = rv.y * dpr, edge = 14 * dpr;
    ctx.globalCompositeOperation = 'destination-out';
    var g = ctx.createRadialGradient(x, y, Math.max(0, R - edge), x, y, R + 0.01);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, R + 0.01, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalCompositeOperation = 'source-over';
}
