// Пузырь голосового как в Telegram Web A: круглая кнопка 48 px (play ↔ pause с пружинкой, при загрузке —
// кольцо с крестиком), справа — волна на canvas высотой 23 px (полоски 2 px через 2 px, скругление 1,
// не ниже 2 px; их число растёт с длительностью: 25…75 на компьютере, 20…45 на телефоне), под ней —
// длительность (во время игры — сколько прошло) и точка «не прослушано».
// Прослушанное — цветом прогресса, остальное — цветом заливки на 50%; новое входящее целиком в цвете прогресса.
// Перемотка перетаскиванием: пока тянем — пауза и предпросмотр, отпустили — переход и продолжение.
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { cx, ForwardTitle, Icon, MessageStatus, ProgressRing } from '../kit.js';
import { requestMeasure, requestMutation } from '../schedule.js';
import { fromBase64, unpack, waveBars } from './waveform.js';
import * as player from './player.js';

var SPIKE = 2, STEP = 4, RADIUS = 1, MIN_H = 2, HEIGHT = 23;

export function spikeCount(duration) {
  var w = typeof innerWidth === 'number' ? innerWidth : 1280;
  var min = 25, max = 75;
  if (w <= 375) { min = 16; max = 35; } else if (w <= 600) { min = 20; max = 45; }
  return Math.round(min + (max - min) * Math.min(1, (duration || 0) / 10));
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  var h0 = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h0 ? h0 + ':' + (m < 10 ? '0' : '') + m : m) + ':' + (s < 10 ? '0' : '') + s;
}

export function VoiceBubble(props) {
  var out = props.from === 'out';
  var duration = props.duration || 0;
  var canvas = useRef(null), timeRef = useRef(null), btn = useRef(null);
  var spikes = useRef(null), progress = useRef(0), drag = useRef(null), colors = useRef(null);
  var key = props.trackKey;
  if (!spikes.current || spikes.current.d !== duration || spikes.current.w !== props.waveform) {
    spikes.current = { d: duration, w: props.waveform, list: waveBars(props.waveform ? unpack(fromBase64(props.waveform)).slice(0, 100) : [], spikeCount(duration)) };
  }
  var width = spikes.current.list.length * STEP - (STEP - SPIKE);
  var filled = !!props.unreadIncoming;   // новое входящее — целиком цветом прогресса, пока не послушали
  var filledRef = useRef(filled);
  filledRef.current = filled;

  function paint() {
    var c = canvas.current;
    if (!c || !colors.current) return;
    var dpr = colors.current.dpr, list = spikes.current.list, peak = 0, i, filled = filledRef.current;
    var width = list.length * STEP - (STEP - SPIKE);
    for (i = 0; i < list.length; i++) if (list[i] > peak) peak = list[i];
    if (c.width !== width * dpr) { c.width = width * dpr; c.height = HEIGHT * dpr; }
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, HEIGHT);
    var px = progress.current * width;
    for (var pass = 0; pass < 2; pass++) {
      // два прохода с обрезкой: слева от позиции — прогресс, справа — заливка на 50%
      g.save();
      g.beginPath();
      if (pass === 0) g.rect(0, 0, px, HEIGHT); else g.rect(px, 0, width - px, HEIGHT);
      g.clip();
      g.fillStyle = pass === 0 || filled ? colors.current.progress : colors.current.fill;
      g.globalAlpha = pass === 0 || filled ? 1 : 0.5;
      for (i = 0; i < list.length; i++) {
        var hgt = Math.max(MIN_H, peak ? HEIGHT * list[i] / peak : 0);
        var x = i * STEP, y = HEIGHT - hgt;
        g.beginPath();
        if (g.roundRect) g.roundRect(x, y, SPIKE, hgt, RADIUS); else g.rect(x, y, SPIKE, hgt);
        g.fill();
      }
      g.restore();
    }
  }
  function writeTime(t, playing) {
    if (!timeRef.current) return;
    var text = playing || t > 0 ? fmt(t) : fmt(duration);
    if (timeRef.current.textContent !== text) timeRef.current.textContent = text;
  }

  useEffect(function () {
    requestMeasure(function () {
      // цвета — вычисленные (color у canvas — заливка, outline-color — прогресс): так работают и color-mix, и темы
      var cs = getComputedStyle(canvas.current);
      colors.current = { fill: cs.color, progress: cs.outlineColor, dpr: window.devicePixelRatio || 1 };
      requestMutation(paint);
    });
    var offTick = player.onTick(function (k, t, d) {
      if (k !== key) { if (progress.current && !drag.current) { progress.current = 0; requestMutation(function () { paint(); writeTime(0, false); }); } return; }
      if (drag.current) return;
      progress.current = d ? t / d : 0;
      requestMutation(function () { paint(); writeTime(t, true); });
    });
    var off = player.subscribe(function (s) {
      var mine = s.key === key;
      if (btn.current) btn.current.classList.toggle('rl-vb-playing', mine && s.playing);
      if (btn.current) btn.current.setAttribute('aria-label', mine && s.playing ? 'Пауза' : 'Воспроизвести');
    });
    var s0 = player.playerState();
    if (s0.key === key) { progress.current = s0.duration ? s0.time / s0.duration : 0; if (btn.current) btn.current.classList.toggle('rl-vb-playing', s0.playing); }
    return function () { offTick(); off(); };
  }, [key]);
  useEffect(function () { requestMutation(paint); }, [props.waveform, duration, filled]);

  function track() { return props.track(); }
  function onDown(e) {
    if (props.uploading) return;
    e.stopPropagation();
    var el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    var s = player.playerState();
    drag.current = { was: s.key === key && s.playing, rect: el.getBoundingClientRect() };
    if (drag.current.was) player.pause();
    move(e);
  }
  function move(e) {
    var d = drag.current;
    if (!d) return;
    progress.current = Math.min(1, Math.max(0, (e.clientX - d.rect.left) / d.rect.width));
    requestMutation(function () { paint(); writeTime(progress.current * duration, true); });
  }
  function up() {
    var d = drag.current;
    if (!d) return;
    drag.current = null;
    var p = progress.current, t = track();
    if (player.playerState().key !== key) { player.play(t); if (!d.was) player.pause(); }
    player.seek(key, p);
    if (d.was) player.play(t);
  }

  var unreadDot = props.unread;
  return h('div', { class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-bubble rl-vb', out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && 'rl-bubble-tail', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in')) },
      props.fwd ? h(ForwardTitle, { fwd: props.fwd }) : null,
      h('div', { class: 'rl-vb-row' },
        h('button', {
          type: 'button', ref: btn, class: cx('rl-vb-btn', props.uploading && 'rl-vb-loading'), 'aria-label': 'Воспроизвести',
          onClick: function (e) { e.stopPropagation(); if (props.uploading) { if (props.onCancel) props.onCancel(); return; } player.toggle(track()); },
        },
          h(Icon, { name: 'play', size: 26, class: 'rl-vb-play' }),
          h(Icon, { name: 'pause', size: 26, class: 'rl-vb-pause' }),
          props.uploading ? h('span', { class: 'rl-vb-ring' }, h(ProgressRing, { size: 48, progress: props.progress, onMedia: true, label: 'Отправка' }), h(Icon, { name: 'close', size: 20, class: 'rl-vb-cancel' })) : null),
        h('div', { class: 'rl-vb-body' },
          h('canvas', { ref: canvas, class: 'rl-vb-wave', style: { width: width + 'px', height: HEIGHT + 'px' }, role: 'slider', 'aria-label': 'Позиция', 'aria-valuemin': 0, 'aria-valuemax': duration, tabIndex: -1,
            onPointerDown: onDown, onPointerMove: move, onPointerUp: up, onPointerCancel: up }),
          h('div', { class: 'rl-vb-foot' },
            h('span', { ref: timeRef, class: 'rl-vb-time' }, fmt(duration)),
            unreadDot ? h('span', { class: 'rl-vb-dot', 'aria-label': 'Не прослушано' }) : null))),
      h('span', { class: 'rl-bubble-meta' }, props.time, out ? h(MessageStatus, { status: props.status || 'sent' }) : null)));
}
