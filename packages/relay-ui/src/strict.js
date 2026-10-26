/* Strict DOM — dev-проверка дисциплины measure/mutate (написана с нуля, MIT).
   Перехватывает чтения раскладки и записи в DOM и сообщает, кто нарушил порядок кадра:
     • чтение в фазе mutate;
     • запись в фазе measure;
     • чтение вне фаз, когда после последней раскладки уже были записи (принудительный пересчёт).
   Записи вне фаз разрешены (обработчики событий), они лишь «пачкают» раскладку.
   Осознанные исключения — через forceMeasure(fn) из schedule.js.
   Отчёт: console.warn по первому разу с каждого места + window.__strictDom.report(). */
import { currentPhase } from './schedule.js';

// «Грязь» раскладки двух видов. Записи внутри кадра (requestAnimationFrame, в том числе фаза mutate) браузер
// разложит сам в конце этого же кадра — они опасны только для чтений дальше в этом же кадре. Записи из обычных задач
// (обработчики событий, сообщения воркера) висят до следующей раскладки — их видят и события прокрутки следующего кадра.
var enabled = false, dirtyTask = false, dirtyFrame = false, inFrame = false, frameTs = -1, sites = new Map(), opts = {}, subs = new Set();

// стек: violation → onRead/onWrite → обёртка → вызвавший код. Первые три кадра — наши (в бандле имени файла нет)
function where(stack) {
  var lines = String(stack || '').split('\n').slice(1).map(function (l) { return l.trim().replace(/^at\s+/, ''); });
  return lines.slice(3, 5).join('  ←  ') || '?';
}

function violation(kind, prop) {
  var err = new Error('[strict-dom] ' + kind + ': ' + prop);
  var at = where(err.stack);
  if (opts.ignore && opts.ignore.test(at)) return;
  var key = kind + ' ' + prop + ' @ ' + at;
  var v = sites.get(key);
  if (v) { v.count++; return; }
  sites.set(key, { kind: kind, prop: prop, at: at, phase: currentPhase(), count: 1, stack: err.stack, t: Date.now() });
  console.warn('[strict-dom] ' + kind + ' — ' + prop + '\n    at ' + at);
  subs.forEach(function (fn) { try { fn(); } catch (e) { /* подписчик не ломает проверку */ } });
}

function onRead(prop) {
  if (!enabled) return;
  var ph = currentPhase();
  if (ph === 'mutate') violation('read in mutate phase', prop);
  else if (ph === null && (dirtyTask || inFrame && dirtyFrame)) violation('forced layout (read after writes, outside measure)', prop);
  dirtyTask = dirtyFrame = false; // раскладка теперь посчитана
}

function onWrite(prop) {
  if (!enabled) return;
  if (currentPhase() === 'measure') violation('write in measure phase', prop);
  if (inFrame) dirtyFrame = true; else dirtyTask = true;
}

function wrapMethod(proto, name, hook) {
  var orig = proto && proto[name];
  if (typeof orig !== 'function') return;
  proto[name] = function () { hook(name); return orig.apply(this, arguments); };
}
function wrapAccessor(proto, name, onGet, onSet) {
  var d = proto && Object.getOwnPropertyDescriptor(proto, name);
  if (!d || !d.configurable) return;
  Object.defineProperty(proto, name, {
    configurable: true, enumerable: d.enumerable,
    get: d.get ? function () { if (onGet) onGet(name); return d.get.call(this); } : undefined,
    set: d.set ? function (v) { if (onSet) onSet(name); d.set.call(this, v); } : undefined,
  });
}

var READ_GETTERS = {
  Element: ['clientTop', 'clientLeft', 'clientWidth', 'clientHeight', 'scrollTop', 'scrollLeft', 'scrollWidth', 'scrollHeight'],
  HTMLElement: ['offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight', 'offsetParent', 'innerText'],
};
var READ_METHODS = { Element: ['getBoundingClientRect', 'getClientRects'] };
var WRITE_METHODS = {
  Node: ['appendChild', 'insertBefore', 'removeChild', 'replaceChild'],
  Element: ['setAttribute', 'removeAttribute', 'toggleAttribute', 'append', 'prepend', 'remove', 'replaceWith', 'before', 'after', 'scrollTo', 'scrollBy', 'scrollIntoView'],
  DOMTokenList: ['add', 'remove', 'toggle', 'replace'],
  CSSStyleDeclaration: ['setProperty', 'removeProperty'],
};

/** Включена ли проверка на этой странице (в dev-сборке — с запуска; в обычной — из раздела разработчика, до перезагрузки). */
export function strictDomEnabled() { return enabled; }
/** Места нарушений: по одному на «вид + свойство + место», с числом повторов и стеком (новые — в конце). */
export function strictDomReport() {
  return Array.from(sites.values()).map(function (v) { return { kind: v.kind, prop: v.prop, at: v.at, phase: v.phase, count: v.count, stack: v.stack, t: v.t }; });
}
export function strictDomReset() { sites.clear(); subs.forEach(function (fn) { fn(); }); }
/** Новое место нарушения — вызвать fn (раздел разработчика обновляет список). */
export function subscribeStrictDom(fn) { subs.add(fn); return function () { subs.delete(fn); }; }

/** Включить (один раз за страницу). opts.ignore — RegExp мест, которые не проверять (сторонние библиотеки). */
export function enableStrictDom(options) {
  if (enabled || typeof window === 'undefined') return;
  enabled = true;
  opts = options || {};
  Object.keys(READ_GETTERS).forEach(function (k) { READ_GETTERS[k].forEach(function (n) { wrapAccessor(window[k] && window[k].prototype, n, onRead, n === 'scrollTop' || n === 'scrollLeft' ? onWrite : null); }); });
  Object.keys(READ_METHODS).forEach(function (k) { READ_METHODS[k].forEach(function (n) { wrapMethod(window[k] && window[k].prototype, n, onRead); }); });
  Object.keys(WRITE_METHODS).forEach(function (k) { WRITE_METHODS[k].forEach(function (n) { wrapMethod(window[k] && window[k].prototype, n, onWrite); }); });
  // style.width = …, style.transform = … — аксессоры CSSStyleDeclaration; textContent / innerHTML — записи
  var csp = window.CSSStyleDeclaration && CSSStyleDeclaration.prototype;
  if (csp) Object.getOwnPropertyNames(csp).forEach(function (n) { var d = Object.getOwnPropertyDescriptor(csp, n); if (d && d.set && n !== 'parentRule') wrapAccessor(csp, n, null, onWrite); });
  wrapAccessor(Node.prototype, 'textContent', null, onWrite);
  wrapAccessor(Element.prototype, 'innerHTML', null, onWrite);
  var gcs = window.getComputedStyle;
  window.getComputedStyle = function (el, pseudo) { onRead('getComputedStyle'); return gcs.call(window, el, pseudo); };
  // колбэки кадра помечаем: записи в них разложатся в конце кадра. Новый кадр (другая метка времени) — раскладка
  // прошлого уже сделана, её «грязь» снимаем
  var raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return raf.call(window, function (ts) {
      if (ts !== frameTs) { frameTs = ts; dirtyFrame = false; }
      var was = inFrame; inFrame = true;
      try { cb(ts); } finally { inFrame = was; }
    });
  };
  // ResizeObserver зовёт колбэк сразу после раскладки, до отрисовки: читать в нём бесплатно
  var RO = window.ResizeObserver;
  if (RO) window.ResizeObserver = class extends RO {
    constructor(cb) { super(function (entries, obs) { dirtyTask = dirtyFrame = false; var was = inFrame; inFrame = true; try { cb(entries, obs); } finally { inFrame = was; } }); }
  };
  // записи из задач раскладываются в следующем кадре: снимаем их «грязь» сразу за ним (задача после отрисовки)
  (function loop() { raf.call(window, function () { setTimeout(function () { dirtyTask = false; }, 0); loop(); }); })();
  window.__strictDom = {
    report: function () { return Array.from(sites.values()).map(function (v) { return { kind: v.kind, prop: v.prop, at: v.at, phase: v.phase, count: v.count }; }); },
    reset: function () { sites.clear(); },
  };
}
