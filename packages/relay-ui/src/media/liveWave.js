// Живая волна записи на canvas: полоски 3 px через 3 px, скругление 1.5 (тишина — точки), не ниже 3 px
// и не выше 80% высоты. Новые пики входят справа и уезжают влево; масштаб — по самому громкому пику записи
// (начинает с 0.05, так что тихий микрофон не рисует «шум» во всю высоту).
// На паузе — вся запись целиком, сжатая под ширину; слева от позиции воспроизведения — ярко, справа — 30%.
// Рисование — только в фазе записи кадра, замер — один раз (ResizeObserver).
import { requestMeasure, requestMutation } from '../schedule.js';

var BAR = 3, GAP = 3, RADIUS = 1.5, MIN_H = 3, MAX_SHARE = 0.8;

export function LiveWave(canvas) {
  this.canvas = canvas;
  this.peaks = [];
  this.max = 0.05;
  this.overview = null;       // пауза: значения 0…1 на всю ширину
  this.progress = -1;         // пауза: позиция воспроизведения 0…1 (−1 — не играет)
  this.w = 0; this.h = 0; this.dpr = 1; this.color = '#3390ec';
  this.queued = false;
  var self = this;
  this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(function () { self.measure(); }) : null;
  if (this.ro) this.ro.observe(canvas);
  this.measure();
}

LiveWave.prototype.measure = function () {
  var self = this;
  requestMeasure(function () {
    var r = self.canvas.getBoundingClientRect();
    self.w = Math.round(r.width); self.h = Math.round(r.height);
    self.dpr = window.devicePixelRatio || 1;
    self.color = getComputedStyle(self.canvas).color || self.color;
    self.draw();
  });
};

/** Сколько полосок влезает. */
LiveWave.prototype.capacity = function () { return Math.max(1, Math.floor((this.w + GAP) / (BAR + GAP))); };

LiveWave.prototype.push = function (peak) {
  if (peak > this.max) this.max = peak;
  this.peaks.push(peak);
  if (this.peaks.length > 600) this.peaks.splice(0, this.peaks.length - 600);
  this.draw();
};

LiveWave.prototype.setOverview = function (values, progress) {
  this.overview = values; this.progress = progress == null ? -1 : progress;
  this.draw();
};
LiveWave.prototype.setProgress = function (p) { if (this.progress !== p) { this.progress = p; this.draw(); } };
LiveWave.prototype.live = function () { this.overview = null; this.progress = -1; this.draw(); };

LiveWave.prototype.draw = function () {
  if (this.queued) return;
  this.queued = true;
  var self = this;
  requestMutation(function () { self.queued = false; self.paint(); });
};

LiveWave.prototype.paint = function () {
  var c = this.canvas, w = this.w, h = this.h, dpr = this.dpr;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  var g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = this.color;
  var n = this.capacity(), list, scale;
  if (this.overview) { list = this.overview.slice(0, n); scale = 1; }
  else { list = this.peaks.slice(-n); scale = this.max; }
  var maxH = h * MAX_SHARE;
  // живая запись прижата вправо, обзор паузы — влево
  var x0 = this.overview ? 0 : w - list.length * (BAR + GAP) + GAP;
  for (var i = 0; i < list.length; i++) {
    var bh = Math.max(MIN_H, Math.min(maxH, list[i] / scale * maxH));
    var x = Math.round((x0 + i * (BAR + GAP)) * dpr) / dpr, y = (h - bh) / 2;
    g.globalAlpha = this.overview && this.progress >= 0 && (i + 0.5) / list.length > this.progress ? 0.3 : 1;
    roundRect(g, x, y, BAR, bh, RADIUS);
  }
  g.globalAlpha = 1;
};

LiveWave.prototype.destroy = function () { if (this.ro) this.ro.disconnect(); };

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); }
  g.fill();
}
