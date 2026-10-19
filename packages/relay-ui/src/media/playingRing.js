// PlayingRing — кольцо из штрихов вокруг обложки играющего трека (как в Telegram): длина каждого штриха — громкость
// своей частотной полосы. Полосы — логарифмически от низких к высоким по половине круга, вторая половина — зеркально
// (рисунок симметричный). Штрихи мягко догоняют цель; на паузе опадают до точек и цикл кадров останавливается.
// Нет анализатора (iOS, контекст не запущен) — «дышит» синтетическая волна. prefers-reduced-motion — статичное кольцо.
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { cx, reducedMotion } from '../kit.js';
import { requestMutation } from '../schedule.js';
import { analyser } from './player.js';

var TICKS = 52;
var BOX = 68, C = BOX / 2, R = 26;          // кольцо 68 вокруг обложки 48: выступает на 10 с каждой стороны
var MIN_LEN = 0.5, MAX_LEN = 6;
var LOW_HZ = 32, HIGH_HZ = 16000;
var EASE = 0.22, SETTLED = 0.004;
var HALF = TICKS / 2;
var ANGLES = [];
for (var i = 0; i < TICKS; i++) ANGLES.push(360 / TICKS * i);

/** Полоса каждого штриха: номер бина спектра и усиление (высоким — больше, иначе их почти не видно). */
function bands(binCount, sampleRate) {
  var binHz = sampleRate / 2 / binCount;
  return ANGLES.map(function (_, k) {
    var pos = (k < HALF ? k : TICKS - k) / HALF;   // 0 вверху круга → 1 внизу, по обеим сторонам
    var hz = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, pos);
    return { bin: Math.min(binCount - 1, Math.round(hz / binHz)), gain: 1 + 0.5 * pos };
  });
}

/** Без анализатора: сумма двух бегущих синусоид — кольцо живое, но спокойное. */
function synthetic(out) {
  var t = performance.now() / 1000;
  for (var k = 0; k < out.length; k++) {
    var v = 0.34 + 0.28 * Math.sin(t * 2.3 + k * 0.37) + 0.18 * Math.sin(-t * 1.4 + k * 0.61);
    out[k] = Math.max(0, Math.min(1, v));
  }
}

export function PlayingRing(props) {
  var group = useRef(null);
  var level = useRef(new Float32Array(TICKS));
  var paused = !!props.paused;

  useEffect(function () {
    var g = group.current;
    if (!g) return undefined;
    var lines = g.querySelectorAll('line');
    var lv = level.current, target = new Float32Array(TICKS);
    var data = null, map = null, raf = 0, alive = true;
    var still = reducedMotion();

    function draw() {
      if (!alive) return;
      for (var k = 0; k < lines.length; k++) lines[k].setAttribute('y2', String(C - R - (MIN_LEN + lv[k] * (MAX_LEN - MIN_LEN))));
    }
    function fill() {
      if (paused) { target.fill(0); return; }
      if (still) { target.fill(0.35); return; }
      var an = analyser();
      if (!an) { synthetic(target); return; }
      if (!data || data.length !== an.frequencyBinCount) { data = new Uint8Array(an.frequencyBinCount); map = bands(an.frequencyBinCount, an.context.sampleRate); }
      an.getByteFrequencyData(data);
      for (var k = 0; k < TICKS; k++) target[k] = Math.min(1, Math.pow(data[map[k].bin] / 255, 1.4) * map[k].gain);
    }
    function frame() {
      fill();
      var settled = true;
      for (var k = 0; k < TICKS; k++) {
        lv[k] += (target[k] - lv[k]) * (still ? 1 : EASE);
        if (Math.abs(target[k] - lv[k]) > SETTLED) settled = false;
      }
      requestMutation(draw);
      if ((paused || still) && settled) return;   // успокоилось — кадры не тратим
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return function () { alive = false; cancelAnimationFrame(raf); };
  }, [paused]);

  return h('svg', { class: cx('rl-pring', (props.className || props.class)), viewBox: '0 0 ' + BOX + ' ' + BOX, 'aria-hidden': 'true' },
    h('g', { ref: group }, ANGLES.map(function (a) {
      return h('line', { key: a, transform: 'rotate(' + a + ' ' + C + ' ' + C + ')', x1: C, y1: C - R, x2: C, y2: C - R - MIN_LEN });
    })));
}
