// Панель записи (голосовое и кружок) — встаёт на место поля ввода, кнопка отправки остаётся справа.
// [корзина] [пилюля: мигающая точка / ▶ на паузе · живая волна · таймер m:ss,cc] [пауза / продолжить]
// Пробел — пауза/продолжить (на паузе — слушать/стоп), Esc — удалить. Таймер пишется в DOM напрямую
// не чаще раза в 30 мс и только когда текст сменился — без перерисовок компонента на каждый кадр.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon, IconButton } from '../kit.js';
import { LiveWave } from './liveWave.js';

/** m:ss,cc (с часами — h:mm:ss,cc). */
export function recordTime(ms) {
  var cs = Math.floor(ms / 10) % 100, s = Math.floor(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  var two = function (n) { return (n < 10 ? '0' : '') + n; };
  return (hh ? hh + ':' + two(mm) : mm) + ':' + two(ss) + ',' + two(cs);
}

function isTyping(t) {
  return !!(t && t.closest && t.closest('input, textarea, select, button, a, [contenteditable=""], [contenteditable="true"]'));
}

/**
 * session: { kind, elapsed(), pause(), resume(), overview(n), media() → Promise<HTMLMediaElement>, onPeak(fn), maxMs? }
 * onDelete — удалить запись; onPaused(bool) — для родителя (кружок показывает паузу по-своему).
 */
export function RecordBar(props) {
  var s = props.session;
  var paused = useState(false), playing = useState(false);
  var canvas = useRef(null), timer = useRef(null), wave = useRef(null), media = useRef(null), raf = useRef(0);
  var pausedNow = useRef(false);
  pausedNow.current = paused[0];

  useEffect(function () {
    wave.current = new LiveWave(canvas.current);
    var off = s.onPeak(function (p) { if (!pausedNow.current && wave.current) wave.current.push(p); });
    var last = '', lastAt = 0;
    function tick(now) {
      raf.current = requestAnimationFrame(tick);
      if (now - lastAt < 30) return;
      lastAt = now;
      var m = media.current, ms;
      if (m && !m.paused) ms = m.currentTime * 1000;
      else ms = pausedNow.current && m && m.currentTime > 0 ? m.currentTime * 1000 : s.elapsed();
      if (m && wave.current && pausedNow.current) wave.current.setProgress(m.duration > 0 && isFinite(m.duration) ? m.currentTime / m.duration : 0);
      var t = recordTime(ms);
      if (t !== last && timer.current) { timer.current.textContent = t; last = t; }
    }
    raf.current = requestAnimationFrame(tick);
    return function () { cancelAnimationFrame(raf.current); off(); if (wave.current) wave.current.destroy(); stopMedia(); };
  }, []);

  // запись упёрлась в предел (кружок — 60 с): панель встаёт на паузу сама
  useEffect(function () { if (props.forcePaused && !paused[0]) setPaused(true); }, [props.forcePaused]);

  function stopMedia() {
    var m = media.current;
    if (m) { m.pause(); if (m.src && m.src.indexOf('blob:') === 0 && !m.__keepSrc) URL.revokeObjectURL(m.src); }
    media.current = null; playing[1](false);
  }

  async function setPaused(on) {
    if (on) {
      paused[1](true);
      await s.pause();
      if (wave.current) wave.current.setOverview(s.overview(wave.current.capacity()), 0);
      if (props.onPaused) props.onPaused(true);
    } else {
      if (props.limitReached) return;
      stopMedia();
      if (wave.current) wave.current.live();
      s.resume();
      paused[1](false);
      if (props.onPaused) props.onPaused(false);
    }
  }

  async function togglePlay() {
    if (playing[0] && media.current) { media.current.pause(); playing[1](false); return; }
    if (!media.current) {
      var m = await s.media();
      if (!m) return;
      media.current = m;
      m.onended = function () { playing[1](false); m.currentTime = 0; if (wave.current) wave.current.setProgress(0); };
    }
    media.current.play().then(function () { playing[1](true); }, function () { playing[1](false); });
  }

  function seek(e) {
    if (!paused[0]) return;
    var el = e.currentTarget, x = e.clientX;
    var r = el.getBoundingClientRect(), p = Math.min(1, Math.max(0, (x - r.left) / r.width));
    var apply = function (m) { if (m.duration > 0 && isFinite(m.duration)) m.currentTime = p * m.duration; if (wave.current) wave.current.setProgress(p); };
    if (media.current) apply(media.current);
    else s.media().then(function (m) { if (!m) return; media.current = m; m.onended = function () { playing[1](false); }; apply(m); });
  }

  // Пробел и Esc — откуда угодно, кроме полей ввода и кнопок
  useEffect(function () {
    function onKey(e) {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key === 'Escape') { e.preventDefault(); props.onDelete(); return; }
      if ((e.key === ' ' || e.code === 'Space') && !isTyping(e.target) && !e.repeat) {
        e.preventDefault();
        if (paused[0] && (media.current || playing[0])) togglePlay();
        else setPaused(!paused[0]);
      }
    }
    window.addEventListener('keydown', onKey);
    return function () { window.removeEventListener('keydown', onKey); };
  });

  var otherIcon = s.kind === 'round' ? 'roundVideo' : 'mic';
  return h('div', { class: cx('rl-recbar', paused[0] && 'rl-recbar-paused'), role: 'group', 'aria-label': s.kind === 'round' ? 'Запись видеосообщения' : 'Запись голосового' },
    h(IconButton, { icon: 'trash', label: 'Удалить запись', class: 'rl-recbar-del', onClick: props.onDelete }),
    h('div', { class: 'rl-recbar-pill' },
      h('span', { class: 'rl-recbar-ctl' },
        paused[0]
          ? h('button', { type: 'button', key: 'play', class: 'rl-recbar-play', 'aria-label': playing[0] ? 'Пауза' : 'Прослушать', onClick: togglePlay }, h(Icon, { name: playing[0] ? 'pause' : 'play', size: 14 }))
          : h('span', { key: 'dot', class: 'rl-recbar-dot', 'aria-hidden': 'true' })),
      h('canvas', { ref: canvas, class: cx('rl-recbar-wave', paused[0] && 'rl-recbar-wave-seek'), onPointerDown: seek, 'aria-hidden': 'true' }),
      h('span', { ref: timer, class: 'rl-recbar-time', 'aria-live': 'off' }, '0:00,00')),
    h(IconButton, { icon: paused[0] ? otherIcon : 'pause', label: paused[0] ? 'Продолжить запись' : 'Пауза', class: cx('rl-recbar-pause', props.limitReached && paused[0] && 'rl-recbar-pause-off'),
      onClick: function () { setPaused(!paused[0]); } }));
}

/** Голосовая запись как «сессия» для панели: на паузе слушаем снимок записанного. */
export function voiceSession(rec, peaks) {
  return {
    kind: 'voice',
    elapsed: function () { return rec.elapsed(); },
    pause: function () { return rec.pause(); },
    resume: function () { rec.resume(); },
    overview: function (n) { return rec.overview(n); },
    onPeak: peaks.subscribe,
    media: function () {
      return rec.snapshot().then(function (blob) { var a = new Audio(URL.createObjectURL(blob)); a.preload = 'auto'; return a; });
    },
    stop: function (cancel) { return rec.stop(cancel); },
  };
}

/** Простая рассылка пиков: рекордер шлёт, панель подписывается. */
export function peakHub() {
  var subs = [];
  return {
    emit: function (p) { for (var i = 0; i < subs.length; i++) subs[i](p); },
    subscribe: function (fn) { subs.push(fn); return function () { subs = subs.filter(function (x) { return x !== fn; }); }; },
  };
}
