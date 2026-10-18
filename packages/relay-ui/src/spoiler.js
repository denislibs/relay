// Спойлер: текст прячется под «шумом» из точек (как в Telegram), по клику раскрывается кругом от
// места нажатия — сразу во всём сообщении. Свой движок: точки рисуются на canvas один раз и
// работают как маска, поэтому берут цвет текста (и во входящем, и в исходящем пузыре, и в теме).
// Одно и то же — в ленте, в превью строки чата и в поле ввода.
import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cx, reducedMotion } from './kit.js';
import { requestMeasure, requestMutation } from './schedule.js';

var installed = false;

/** Плитка со случайными точками: альфа — для маски, серая — для поля ввода, где текст виден. */
function tile(fill) {
  var c = document.createElement('canvas'), dpr = 2, w = 60, hgt = 20;
  c.width = w * dpr; c.height = hgt * dpr;
  var x = c.getContext('2d');
  if (!x) return null;
  // детерминированный шум: одинаковая картинка при каждой загрузке
  var seed = 7;
  function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
  for (var i = 0; i < 90; i++) {
    x.globalAlpha = 0.35 + rnd() * 0.65;
    x.fillStyle = fill;
    x.beginPath();
    x.arc(rnd() * c.width, rnd() * c.height, (0.45 + rnd() * 0.5) * dpr, 0, Math.PI * 2);
    x.fill();
  }
  return c.toDataURL('image/png');
}

/** Точки — в CSS-переменные корня. Вызывать до первого спойлера (иначе на кадр — сплошная плашка). */
export function installSpoilers() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  var mask = tile('#fff'), gray = tile('rgb(128,128,128)');
  if (!mask) return;
  var s = document.documentElement.style;
  s.setProperty('--rl-spoiler-dots', 'url(' + mask + ')');
  s.setProperty('--rl-spoiler-dots-gray', 'url(' + gray + ')');
}

/* ---------- Частицы в воркере (как в Telegram Web K): одно наложение-canvas на сообщение ----------
   Пока воркер не нарисовал первый кадр (или его нет вовсе) — работают CSS-точки выше. */
var workerUrl = null, worker = null, failed = false, nextId = 1;
var scopes = new Map();   // элемент-область → { id, canvas, spans:Set, ready }
var io = null, ro = null;

/** Включить частицы: путь к собранному spoiler.worker.js. Без вызова остаются CSS-точки. */
export function configureSpoilers(opts) { workerUrl = opts && opts.workerUrl; }

function supported() {
  return !failed && !!workerUrl && typeof Worker === 'function' && typeof OffscreenCanvas === 'function' &&
    typeof HTMLCanvasElement !== 'undefined' && 'transferControlToOffscreen' in HTMLCanvasElement.prototype;
}

function getWorker() {
  if (worker || !supported()) return worker;
  try { worker = new Worker(workerUrl, { type: 'module' }); } catch (e) { failed = true; return null; }
  worker.onerror = function () { failed = true; scopes.forEach(function (s, el) { drop(el); }); };
  worker.onmessage = function (e) {
    if (e.data && e.data.type === 'drawn') scopes.forEach(function (s, el) {
      if (s.id === e.data.id && !s.ready) { s.ready = true; requestMutation(function () { el.setAttribute('data-spoiler-live', ''); }); }
    });
  };
  io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) { var s = scopes.get(en.target); if (s && s.id) worker.postMessage({ type: en.isIntersecting ? 'play' : 'pause', id: s.id }); });
  }, { rootMargin: '100px' });
  ro = new ResizeObserver(function (entries) { entries.forEach(function (en) { if (scopes.has(en.target)) measure(en.target); }); });
  return worker;
}

function scopeOf(span, sel) {
  return (sel && span.closest(sel)) || span.closest('[data-spoiler-scope], .rl-bubble, .rl-row') || span.parentElement || span;
}

/** Прямоугольники закрытых спойлеров области — относительно области; цвет — цвет текста. Фаза замера. */
function measure(el) {
  var s = scopes.get(el);
  if (!s || s.pending) return;
  s.pending = true;
  requestMeasure(function () {
    s.pending = false;
    if (scopes.get(el) !== s) return;
    var box = el.getBoundingClientRect(), rects = [], color = null;
    s.spans.forEach(function (sp) {
      if (sp.classList.contains('rl-spoiler-open') || sp.classList.contains('rl-spoiler-revealing')) return;
      // видимая часть: строка с многоточием (overflow: hidden) обрезает спойлер — частицы тоже
      var clip = { l: box.left, t: box.top, r: box.right, b: box.bottom };
      for (var a = sp.parentElement; a && a !== el; a = a.parentElement) {
        if (getComputedStyle(a).overflowX !== 'visible') { var ar = a.getBoundingClientRect(); clip = { l: Math.max(clip.l, ar.left), t: Math.max(clip.t, ar.top), r: Math.min(clip.r, ar.right), b: Math.min(clip.b, ar.bottom) }; }
      }
      var list = sp.getClientRects();
      for (var i = 0; i < list.length; i++) {
        var r = list[i], L = Math.max(r.left, clip.l), T = Math.max(r.top, clip.t), R = Math.min(r.right, clip.r), B = Math.min(r.bottom, clip.b);
        if (R > L && B > T) rects.push([L - box.left, T - box.top, R - L, B - T]);
      }
      if (!color) color = getComputedStyle(sp).color;
    });
    var w = box.width, hgt = box.height, dpr = Math.min(2, window.devicePixelRatio || 1);
    var pos = getComputedStyle(el).position;
    requestMutation(function () {
      if (scopes.get(el) !== s) return;
      var wk = getWorker();
      if (!wk) return;
      if (!s.id) {
        if (pos === 'static') el.style.position = 'relative';
        var c = document.createElement('canvas');
        c.className = 'rl-spoiler-canvas';
        c.setAttribute('aria-hidden', 'true');
        el.appendChild(c);
        var off;
        try { off = c.transferControlToOffscreen(); } catch (e) { failed = true; c.remove(); return; }
        s.id = nextId++; s.canvas = c;
        wk.postMessage({ type: 'attach', id: s.id, canvas: off, w: w, h: hgt, dpr: dpr, rects: rects, color: color || '#888' }, [off]);
        io.observe(el); ro.observe(el);
      } else wk.postMessage({ type: 'update', id: s.id, w: w, h: hgt, rects: rects, color: color || '#888' });
    });
  });
}

function drop(el) {
  var s = scopes.get(el);
  if (!s) return;
  scopes.delete(el);
  if (io) io.unobserve(el);
  if (ro) ro.unobserve(el);
  if (s.id && worker) worker.postMessage({ type: 'detach', id: s.id });
  requestMutation(function () { if (s.canvas) s.canvas.remove(); el.removeAttribute('data-spoiler-live'); });
}

function track(span, sel) {
  if (!supported()) return null;
  var el = scopeOf(span, sel), s = scopes.get(el);
  if (!s) { s = { id: 0, canvas: null, spans: new Set(), ready: false, pending: false }; scopes.set(el, s); }
  s.spans.add(span);
  measure(el);
  return el;
}

function untrack(span, el) {
  var s = el && scopes.get(el);
  if (!s) return;
  s.spans.delete(span);
  if (s.revealing) return;   // наложение доигрывает круг и уберётся само
  if (!s.spans.size) drop(el); else measure(el);
}

/** Раскрытие в наложении: круг из (x, y) экрана; после — наложение убирается. */
function revealOverlay(el, x, y, ms) {
  var s = scopes.get(el);
  if (!s || !s.id || !worker) return;
  var box = el.getBoundingClientRect();
  var px = (x == null ? box.width / 2 : x - box.left), py = (y == null ? box.height / 2 : y - box.top);
  var far = Math.hypot(Math.max(px, box.width - px), Math.max(py, box.height - py)) + 16;
  s.revealing = true;
  worker.postMessage({ type: 'reveal', id: s.id, x: px, y: py, maxDist: far, duration: ms });
  var id = s.id;
  setTimeout(function () { var cur = scopes.get(el); if (cur && cur.id === id) drop(el); }, ms + 50);
}

var EVENT = 'rl-spoiler-reveal';
var REVEAL_MS = 500;

/** Раскрыть все спойлеры области (сообщения) — кругом из точки (x, y) на экране. */
export function revealSpoilers(scope, x, y) {
  var list = scope.querySelectorAll('.rl-spoiler:not(.rl-spoiler-open):not(.rl-spoiler-static)');
  for (var i = 0; i < list.length; i++) list[i].dispatchEvent(new CustomEvent(EVENT, { detail: { x: x, y: y } }));
}

/** Спойлер в тексте сообщения. scope — область, где раскрываются все спойлеры разом (по умолчанию — сообщение). */
export function Spoiler(props) {
  var st = useState('closed'), state = st[0];   // closed → revealing → open
  var el = useRef(null);
  useLayoutEffect(installSpoilers, []);
  // частицы — пока закрыт; открылся — область пересчитывает прямоугольники (или убирает наложение)
  useLayoutEffect(function () {
    if (state !== 'closed' || !el.current) return;
    var node = el.current, scope = track(node, props.scope);
    return function () { untrack(node, scope); };
  }, [state === 'closed']);
  var timer = useRef(null);
  useLayoutEffect(function () { return function () { if (timer.current) clearTimeout(timer.current); }; }, []);
  useLayoutEffect(function () {
    var node = el.current;
    if (!node) return;
    function onReveal(e) {
      if (state !== 'closed') return;
      if (reducedMotion()) { st[1]('open'); return; }
      var r = node.getBoundingClientRect();   // обработчик события, не фаза записи: чтение раскладки здесь законно
      var d = e.detail || {};
      var px = (d.x == null ? r.left + r.width / 2 : d.x) - r.left, py = (d.y == null ? r.top + r.height / 2 : d.y) - r.top;
      // радиус до дальнего угла: круг накрывает весь спойлер
      var far = Math.hypot(Math.max(px, r.width - px), Math.max(py, r.height - py));
      node.style.setProperty('--sx', px + 'px');
      node.style.setProperty('--sy', py + 'px');
      node.style.setProperty('--sr', Math.ceil(far + 12) + 'px');
      st[1]('revealing');
      timer.current = setTimeout(function () { timer.current = null; st[1]('open'); }, REVEAL_MS);
    }
    node.addEventListener(EVENT, onReveal);
    return function () { node.removeEventListener(EVENT, onReveal); };
  }, [state]);
  var open = state === 'open';
  function go(e, x, y) {
    if (state !== 'closed') return;
    e.preventDefault(); e.stopPropagation();   // клик по спойлеру не уходит в ленту (не открывает меню, не выделяет)
    var scope = (props.scope && el.current.closest(props.scope)) || el.current.closest('[data-spoiler-scope], .rl-bubble') || el.current;
    revealSpoilers(scope, x, y);
    var ov = el.current.closest('[data-spoiler-live]');
    if (ov) revealOverlay(ov, x, y, REVEAL_MS);
  }
  return h('span', {
    ref: el,
    class: cx('rl-spoiler', state === 'revealing' && 'rl-spoiler-revealing', open && 'rl-spoiler-open'),
    role: open ? undefined : 'button', tabIndex: open ? undefined : 0,
    'aria-label': open ? undefined : 'Скрытый текст, нажмите, чтобы показать',
    onClick: function (e) { go(e, e.clientX, e.clientY); },
    onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') go(e); },
  }, h('span', { class: 'rl-spoiler-text', 'aria-hidden': open ? undefined : 'true' }, props.children));
}

/** Спойлер, который не раскрывается: превью в списке чатов, цитата. Внутри — заглушка, не настоящий текст. */
export function SpoilerText(props) {
  var el = useRef(null);
  useLayoutEffect(installSpoilers, []);
  useLayoutEffect(function () {
    var node = el.current, scope = node && track(node, props.scope);
    return function () { untrack(node, scope); };
  }, []);
  return h('span', { ref: el, class: 'rl-spoiler rl-spoiler-static', 'aria-label': props.label || 'скрытый текст' },
    h('span', { class: 'rl-spoiler-text', 'aria-hidden': 'true' }, props.children));
}
