/* Relay frame scheduler — written from scratch (MIT), same idea as fastdom / fasterdom:
   one requestAnimationFrame per frame; all measures run first, then all mutations.
   Plus "heavy animation" bookkeeping: while a heavy animation runs, deferrable work waits.

   requestMeasure(fn)        read layout (getBoundingClientRect, scrollTop, offsetHeight…)
   requestMutation(fn)       write to the DOM (styles, classes, scrollTop =, appendChild…)
   beginHeavyAnimation(ms)   → end(); counts overlapping animations, auto-ends after ms
   isHeavyAnimating()
   onHeavyAnimationEnd(fn)   fn runs once when the counter drops to zero (or now, if idle)
   onFullyIdle(fn)           fn runs when no heavy animation AND the browser is idle
   deferDuringAnimation(fn)  runs fn now, or after the current heavy animation */

var measures = [], mutations = [], scheduled = false;
var heavy = 0, endWaiters = [], idleWaiters = [];

function raf(fn) { return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16); }

function flush() {
  scheduled = false;
  var m = measures, w = mutations;
  measures = []; mutations = [];
  for (var i = 0; i < m.length; i++) safe(m[i]);
  for (var j = 0; j < w.length; j++) safe(w[j]);
  // work queued during this frame (a measure scheduling a mutation) lands in the next frame
  if (measures.length || mutations.length) schedule();
}
function safe(fn) { try { fn(); } catch (e) { setTimeout(function () { throw e; }); } }
function schedule() { if (!scheduled) { scheduled = true; raf(flush); } }

export function requestMeasure(fn) { measures.push(fn); schedule(); }
export function requestMutation(fn) { mutations.push(fn); schedule(); }
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
export function deferDuringAnimation(fn) { onHeavyAnimationEnd(fn); }

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
