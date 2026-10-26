// Кружок в ленте — как в Telegram Web A: круг 240 px; пока виден — играет без звука по кругу;
// нажатие — сначала и со звуком (другой кружок и голосовые останавливаются), повторное — пауза;
// кончился — снова без звука по кругу. Кольцо прогресса (белое, 35%, 4 px) — только при игре со звуком.
// Слева сверху — плашка: длительность (при игре — сколько прошло), «без звука», точка «не просмотрено».
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, ForwardTitle, ReplyQuote, MsgLine, Icon, MessageStatus, ProgressRing, ReactionChips } from '../kit.js';
import * as player from './player.js';
import { isHeavyAnimating, onHeavyAnimationEnd } from '../schedule.js';

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
  var st = useState({ on: false, playing: false, loaded: false, got: null, stopped: false });   // got — доля скачанного (null — неизвестно)
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
    var waiting = false, alive = true;
    function start() { if (alive && me.current.visible && v && !(active === me.current && v.paused)) v.play().catch(function () {}); }
    var off = watch(box.current, function (vis) {
      me.current.visible = vis;
      if (!v) return;
      // во время прокрутки к сообщению и других тяжёлых анимаций — не запускаем: пролетающие кружки не декодируют видео
      if (vis && isHeavyAnimating()) { if (!waiting) { waiting = true; onHeavyAnimationEnd(function () { waiting = false; start(); }); } return; }
      if (vis) start();
      else if (active !== me.current) v.pause();
    });
    function tick() {
      raf.current = requestAnimationFrame(tick);
      if (active !== me.current || !v.duration) return;
      var p = v.currentTime / v.duration;
      if (ring.current) ring.current.setAttribute('stroke-dashoffset', (C * (1 - p)).toFixed(1));
      if (badge.current) { var t = fmt(v.currentTime); if (badge.current.textContent !== t) badge.current.textContent = t; }
    }
    raf.current = requestAnimationFrame(tick);
    return function () { alive = false; off(); cancelAnimationFrame(raf.current); if (active === me.current) { active = null; player.release(me.current.stop); } };
  }, []);

  function onTap(e) {
    e.stopPropagation();
    var v = video.current;
    if (props.uploading) { if (props.onCancel) props.onCancel(); return; }
    if (s.stopped) { setS({ stopped: false, got: null }); return; }   // скачивание отменяли — продолжить
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
    if (props.onPlay) props.onPlay();   // начали смотреть со звуком — приложение может докачать файл на устройство
    if (props.onListened) props.onListened();
  }

  var dur = props.duration || 0;
  var hasReact = !!(props.reactions && props.reactions.length);
  return h(MsgLine, { aside: props.aside, class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap', props.fwd && 'rl-round-line-fwd', props.reply && 'rl-round-line-reply', (props.footer || hasReact) && 'rl-round-line-foot') },
    // у кружка нет пузыря — «Переслано от» и цитата одной плашкой сбоку от него, как у стикера в Telegram Web K
    props.fwd || props.reply ? h('div', { class: 'rl-side-head' },
      props.fwd ? h(ForwardTitle, { fwd: props.fwd, class: 'rl-fwd-plate' }) : null,
      props.reply ? h('div', { class: 'rl-reply-plate' }, h(ReplyQuote, Object.assign({ inBubble: true }, props.reply))) : null) : null,
    h('div', { ref: box, class: cx('rl-round', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in'), s.loaded && 'rl-round-loaded', s.on && 'rl-round-on'), onClick: onTap,
      role: 'button', 'aria-label': s.on && s.playing ? 'Пауза' : 'Воспроизвести видеосообщение' },
      props.thumb ? h('img', { class: 'rl-round-thumb', src: props.thumb, alt: '', 'aria-hidden': 'true' }) : null,
      props.src && !s.stopped ? h('video', { ref: video, class: 'rl-round-video', src: props.src, muted: true, loop: true, playsInline: true, preload: 'metadata',
        onLoadedData: function () { setS({ loaded: true }); },
        onProgress: function (e) {
          var v = e.currentTarget;
          if (v.duration > 0 && v.buffered.length) {
            // доля — по самому дальнему скачанному куску и только вперёд: конец последнего куска бывает меньше прежнего, дуга отползала назад
            var end = 0;
            for (var i = 0; i < v.buffered.length; i++) end = Math.max(end, v.buffered.end(i));
            var got = Math.min(1, end / v.duration);
            st[1](function (o) { return o.got != null && o.got >= got ? o : Object.assign({}, o, { got: got }); });
          }
        },
        onEnded: function () { if (active === me.current) { video.current.currentTime = 0; idle(); } },
      }) : null,
      s.on ? h('svg', { class: 'rl-round-ring', viewBox: '0 0 240 240', 'aria-hidden': 'true' },
        h('circle', { ref: ring, cx: 120, cy: 120, r: R, 'stroke-dasharray': C.toFixed(1), 'stroke-dashoffset': C.toFixed(1) })) : null,
      props.uploading ? h('div', { class: 'rl-round-center' }, h(ProgressRing, { size: 54, progress: props.progress, spin: true, onMedia: true, onCancel: props.onCancel, label: 'Отправка' })) : null,
      // как в Telegram: пока видео не пришло — размытое превью и кольцо с крестиком (отменить скачивание)
      !props.uploading && props.src && !s.loaded ? h('div', { class: 'rl-round-center' }, s.stopped
        ? h('span', { class: 'rl-round-dl', 'aria-label': 'Скачать' }, h(Icon, { name: 'download', size: 24 }))
        : h(ProgressRing, { size: 54, progress: s.got == null ? undefined : s.got, spin: true, onMedia: true, label: 'Загрузка видеосообщения',
            onCancel: function (e) { e.stopPropagation(); var v = video.current; if (v) { v.removeAttribute('src'); v.load(); } setS({ stopped: true }); } })) : null,
      h('span', { class: 'rl-round-badge' },
        h('span', { ref: badge }, fmt(dur)),
        !s.on || !s.playing ? h(Icon, { name: 'soundOff', size: 16, class: 'rl-round-muted' }) : null,
        props.unread ? h('i', { class: 'rl-round-dot', 'aria-label': 'Не просмотрено' }) : null),
      h('span', { class: 'rl-round-meta' }, props.metaBefore ? props.metaBefore() : null, props.time, out || props.status ? h(MessageStatus, { status: props.status || 'sent' }) : null)),
    // пост канала: у кружка нет пузыря — кнопка комментариев плашкой под ним
    props.footer ? h('div', { class: 'rl-footer-plate rl-footer-plate-round' }, props.footer) : null,
    // у кружка нет пузыря — реакции плашками под ним, как у стикера
    hasReact ? h(ReactionChips, { items: props.reactions, out: out, float: true, onClick: props.onReact }) : null);
}
