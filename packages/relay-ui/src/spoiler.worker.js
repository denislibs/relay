// Воркер спойлеров: одна симуляция частиц на все сообщения вкладки; каждое сообщение (или строка
// списка) отдаёт сюда свой canvas (OffscreenCanvas) — здесь и рисуется, главный поток свободен.
// Сообщения: attach {id, canvas, w, h, dpr, rects, color} · update {id, w, h, rects, color} ·
// play/pause/detach {id} · reveal {id, x, y, maxDist, duration}. Ответ: drawn {id} после первого кадра.
import { createSim, drawOverlay } from './spoilerSim.js';

var FRAME_MS = 1000 / 30;
var sims = {};            // dpr → плитка
var overlays = new Map(); // id → состояние
var timer = null, last = 0;

function simFor(dpr) {
  var k = String(dpr);
  if (!sims[k]) sims[k] = createSim(new OffscreenCanvas(1, 1), dpr);
  return sims[k];
}

function frame() {
  timer = null;
  var now = performance.now(), dt = Math.min(0.1, (now - last) / 1000 || FRAME_MS / 1000);
  last = now;
  var stepped = {};
  var any = false;
  overlays.forEach(function (o, id) {
    if (!o.playing && !o.reveal) return;
    any = true;
    var k = String(o.dpr);
    if (!stepped[k]) { simFor(o.dpr).step(dt); stepped[k] = true; }
    if (o.reveal) {
      var p = Math.min(1, (now - o.reveal.start) / o.reveal.duration);
      o.reveal.r = o.reveal.maxDist * (p * p);   // ease-in, как раскрытие текста
      if (p >= 1) { o.ctx.clearRect(0, 0, o.canvas.width, o.canvas.height); overlays.delete(id); return; }
    }
    drawOverlay(o.ctx, simFor(o.dpr).canvas, o, o.dpr);
    if (!o.drawn) { o.drawn = true; postMessage({ type: 'drawn', id: id }); }
  });
  if (any) schedule();
}

function schedule() {
  if (timer == null) timer = setTimeout(frame, FRAME_MS);
}

onmessage = function (e) {
  var m = e.data, o = overlays.get(m.id);
  switch (m.type) {
    case 'attach': {
      var ctx = m.canvas.getContext('2d');
      m.canvas.width = Math.max(1, Math.round(m.w * m.dpr));
      m.canvas.height = Math.max(1, Math.round(m.h * m.dpr));
      overlays.set(m.id, { canvas: m.canvas, ctx: ctx, dpr: m.dpr, rects: m.rects, color: m.color, playing: m.playing !== false, reveal: null, drawn: false,
        ox: Math.random() * 160, oy: Math.random() * 64, pattern: null, patternTile: null });
      last = last || performance.now();
      schedule();
      return;
    }
    case 'update':
      if (!o) return;
      var W = Math.max(1, Math.round(m.w * o.dpr)), H = Math.max(1, Math.round(m.h * o.dpr));
      if (o.canvas.width !== W || o.canvas.height !== H) { o.canvas.width = W; o.canvas.height = H; o.pattern = null; }
      o.rects = m.rects; o.color = m.color;
      schedule();
      return;
    case 'play': if (o) { o.playing = true; schedule(); } return;
    case 'pause': if (o) o.playing = false; return;
    case 'reveal':
      if (!o) return;
      o.reveal = { x: m.x, y: m.y, maxDist: m.maxDist, duration: m.duration, start: performance.now(), r: 0 };
      schedule();
      return;
    case 'detach': overlays.delete(m.id); return;
  }
};
