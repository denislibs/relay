// Кружок в ленте — как в Telegram Web A: круг 240 px; пока виден — играет без звука по кругу;
// нажатие — сначала и со звуком (другой кружок и голосовые останавливаются), повторное — пауза;
// кончился — снова без звука по кругу. Кольцо прогресса (белое, 35%, 4 px) — только при игре со звуком.
// Слева сверху — плашка: длительность (при игре — сколько прошло), «без звука», точка «не просмотрено».
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon, MessageStatus, ProgressRing } from '../kit.js';
import * as player from './player.js';

var R = 114, C = 2 * Math.PI * R;   // viewBox 240: 120 − 6
var active = null;                 // кружок, играющий со звуком (один на всё приложение)

var io = null, ioCbs = typeof WeakMap === 'function' ? new WeakMap() : null;
function watch(el, cb) {
  if (!io) io = new IntersectionObserver(function (es) { es.forEach(function (e) { var f = ioCbs.get(e.target); if (f) f(e.isIntersecting); }); });
  ioCbs.set(el, cb); io.observe(el);
  return function () { ioCbs.delete(el); io.unobserve(el); };
}
function fmt(sec) { sec = Math.max(0, Math.floor(sec)); return Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60); }

export function RoundBubble(props) {
  var out = props.from === 'out';
  var box = useRef(null), video = useRef(null), ring = useRef(null), badge = useRef(null), raf = useRef(0);
  var st = useState({ on: false, playing: false, loaded: false });
  var s = st[0];
  var me = useRef(null);

  function setS(p) { st[1](function (o) { return Object.assign({}, o, p); }); }
  function idle() {
    var v = video.current;
    if (!v) return;
    v.muted = true; v.loop = true;
    if (active === me.current) { active = null; player.release(me.current.stop); }
    setS({ on: false, playing: false });
    if (me.current.visible) v.play().catch(function () {});
  }
  me.current = me.current || { visible: false, stop: function () { var v = video.current; if (v) { v.pause(); v.currentTime = 0; } idle(); } };

  useEffect(function () {
    var v = video.current;
    var off = watch(box.current, function (vis) {
      me.current.visible = vis;
      if (!v) return;
      if (vis && !(active === me.current && v.paused)) v.play().catch(function () {});
      else if (!vis && active !== me.current) v.pause();
    });
    function tick() {
      raf.current = requestAnimationFrame(tick);
      if (active !== me.current || !v.duration) return;
      var p = v.currentTime / v.duration;
      if (ring.current) ring.current.setAttribute('stroke-dashoffset', (C * (1 - p)).toFixed(1));
      if (badge.current) { var t = fmt(v.currentTime); if (badge.current.textContent !== t) badge.current.textContent = t; }
    }
    raf.current = requestAnimationFrame(tick);
    return function () { off(); cancelAnimationFrame(raf.current); if (active === me.current) { active = null; player.release(me.current.stop); } };
  }, []);

  function onTap(e) {
    e.stopPropagation();
    var v = video.current;
    if (props.uploading) { if (props.onCancel) props.onCancel(); return; }
    if (!v) return;
    if (active === me.current) {
      if (v.paused) { v.play().catch(function () {}); setS({ playing: true }); } else { v.pause(); setS({ playing: false }); }
      return;
    }
    if (active) active.stop();
    active = me.current;
    player.claim(me.current.stop);   // голосовое на паузу; начнут голосовое — этот кружок остановится
    v.pause(); v.currentTime = 0;     // сначала пауза — иначе iOS не даёт сменить позицию
    v.muted = false; v.loop = false;
    v.play().catch(function () {});
    setS({ on: true, playing: true });
    if (props.onListened) props.onListened();
  }

  var dur = props.duration || 0;
  return h('div', { class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { ref: box, class: cx('rl-round', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in'), s.loaded && 'rl-round-loaded', s.on && 'rl-round-on'), onClick: onTap,
      role: 'button', 'aria-label': s.on && s.playing ? 'Пауза' : 'Воспроизвести видеосообщение' },
      props.thumb ? h('img', { class: 'rl-round-thumb', src: props.thumb, alt: '', 'aria-hidden': 'true' }) : null,
      props.src ? h('video', { ref: video, class: 'rl-round-video', src: props.src, muted: true, loop: true, playsInline: true, preload: 'metadata',
        onLoadedData: function () { setS({ loaded: true }); },
        onEnded: function () { if (active === me.current) { video.current.currentTime = 0; idle(); } },
      }) : null,
      s.on ? h('svg', { class: 'rl-round-ring', viewBox: '0 0 240 240', 'aria-hidden': 'true' },
        h('circle', { ref: ring, cx: 120, cy: 120, r: R, 'stroke-dasharray': C.toFixed(1), 'stroke-dashoffset': C.toFixed(1) })) : null,
      props.uploading ? h('div', { class: 'rl-round-center' }, h(ProgressRing, { progress: props.progress, onMedia: true, onCancel: props.onCancel, label: 'Отправка' })) : null,
      h('span', { class: 'rl-round-badge' },
        h('span', { ref: badge }, fmt(dur)),
        !s.on || !s.playing ? h(Icon, { name: 'soundOff', size: 16, class: 'rl-round-muted' }) : null,
        props.unread ? h('i', { class: 'rl-round-dot', 'aria-label': 'Не просмотрено' }) : null),
      h('span', { class: 'rl-round-meta' }, props.time, out ? h(MessageStatus, { status: props.status || 'sent' }) : null)));
}
