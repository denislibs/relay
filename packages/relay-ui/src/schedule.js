/* Relay frame scheduler — written from scratch (MIT), same idea as fastdom / fasterdom:
   one requestAnimationFrame per frame; all measures run first, then all mutations.
   Plus "heavy animation" bookkeeping: while a heavy animation runs, deferrable work waits.

   requestMeasure(fn)        read layout (getBoundingClientRect, scrollTop, offsetHeight…)
   requestMutation(fn)       write to the DOM (styles, classes, scrollTop =, appendChild…)
   beginHeavyAnimation(ms)   → end(); counts overlapping animations, auto-ends after ms
   isHeavyAnimating()
   onHeavyAnimationEnd(fn)   fn runs once when the counter drops to zero (or now, if idle)
   onFullyIdle(fn)           fn runs when no heavy animation AND the browser is idle
   deferDuringAnimation(fn)  runs fn now, or after the current heavy animation
   frameStats()              counters for the dev section: work in the last frame, deferred work */

var measures = [], mutations = [], scheduled = false;
/* текущая фаза кадра: 'measure' | 'mutate' | 'free' (forceMeasure) | null — для проверки strict-dom */
var phase = null;
export function currentPhase() { return phase; }
var heavy = 0, endWaiters = [], idleWaiters = [];
/* счётчики для раздела «Для разработчиков»: пара присваиваний на кадр, читаются только оттуда */
var lastMeasures = 0, lastMutations = 0, frames = 0, deferredTotal = 0;

function raf(fn) { return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16); }

function flush() {
  scheduled = false;
  var m = measures, w = mutations;
  measures = []; mutations = [];
  lastMeasures = m.length; lastMutations = w.length; frames++;
  phase = 'measure';
  for (var i = 0; i < m.length; i++) safe(m[i]);
  phase = 'mutate';
  for (var j = 0; j < w.length; j++) safe(w[j]);
  phase = null;
  // work queued during this frame (a measure scheduling a mutation) lands in the next frame
  if (measures.length || mutations.length) schedule();
}
function safe(fn) { try { fn(); } catch (e) { setTimeout(function () { throw e; }); } }
function schedule() { if (!scheduled) { scheduled = true; raf(flush); } }

export function requestMeasure(fn) { measures.push(fn); schedule(); }
export function requestMutation(fn) { mutations.push(fn); schedule(); }
/* Прогнать очередь кадра прямо сейчас, до max проходов (работа, поставленная внутри прохода, — следующим).
   Для View Transition: пока браузер ждёт новое состояние страницы, requestAnimationFrame не приходит. */
export function flushFrames(max) { for (var i = 0; i < (max || 1) && (measures.length || mutations.length); i++) flush(); }
/* Осознанное исключение: чтение и запись прямо сейчас, вне кадра (FLIP, первая раскладка до отрисовки).
   Strict-dom такие места не помечает — они видны в коде по этому вызову. */
export function forceMeasure(fn) {
  var prev = phase;
  phase = 'free';
  try { return fn(); } finally { phase = prev; }
}
/* measure now-ish, then mutate with what was measured — the common pair */
export function measureThenMutate(read, write) { requestMeasure(function () { var v = read(); requestMutation(function () { write(v); }); }); }

export function beginHeavyAnimation(ms) {
  heavy++;
  var done = false;
  var t = setTimeout(end, (ms || 300) + 50);
  function end() {
    if (done) return;
    done = true; clearTimeout(t);
    heavy = Math.max(0, heavy - 1);
    if (!heavy) { var ws = endWaiters; endWaiters = []; ws.forEach(safe); pumpIdle(); }
  }
  return end;
}
export function isHeavyAnimating() { return heavy > 0; }
export function onHeavyAnimationEnd(fn) { if (!heavy) fn(); else endWaiters.push(fn); }
export function deferDuringAnimation(fn) { if (heavy) deferredTotal++; onHeavyAnimationEnd(fn); }
/* measures/mutations — задач в последнем кадре; deferred — сколько раз работа ждала конца тяжёлой анимации (всего), waiting — ждёт сейчас */
export function frameStats() {
  return { measures: lastMeasures, mutations: lastMutations, frames: frames, heavy: heavy > 0, heavyCount: heavy, deferred: deferredTotal, waiting: endWaiters.length, idleWaiting: idleWaiters.length };
}

var idleScheduled = false;
function pumpIdle() {
  if (idleScheduled || !idleWaiters.length || heavy) return;
  idleScheduled = true;
  var ric = typeof requestIdleCallback === 'function' ? requestIdleCallback : function (cb) { return setTimeout(function () { cb({ timeRemaining: function () { return 8; } }); }, 50); };
  ric(function (deadline) {
    idleScheduled = false;
    while (idleWaiters.length && !heavy && deadline.timeRemaining() > 2) safe(idleWaiters.shift());
    pumpIdle();
  }, { timeout: 2000 });
}
export function onFullyIdle(fn) { idleWaiters.push(fn); pumpIdle(); }
