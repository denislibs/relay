// Свой плеер видео для просмотрщика (вместо кнопок браузера): одинаковый во всех браузерах, в цветах Relay.
// Полоса с подгруженным, время, громкость, скорость (общая с голосовыми), качество, PiP, во весь экран, клавиши.
// Время и полоса обновляются напрямую в кадре (requestAnimationFrame), без перерисовки компонента; панель прячется,
// пока видео играет и мышь стоит; крутилка — с задержкой показа и минимальным временем, чтобы не мигала.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon, ProgressRing, useMinVisible } from '../kit.js';
import * as player from './player.js';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SEEK_STEP = 5;          // секунд на стрелку
const VOLUME_STEP = 0.1;
const HIDE_MS = 2500;         // столько панель держится без движения мыши, пока видео играет
const CLICK_MS = 220;         // ждём второй клик: двойной — во весь экран, одиночный — пауза
const VOL_KEY = 'relay.video.volume', MUTE_KEY = 'relay.video.muted';

/** 0:07, 1:05, 1:02:03. */
export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  var hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  var s2 = (ss < 10 ? '0' : '') + ss;
  return hh ? hh + ':' + (mm < 10 ? '0' : '') + mm + ':' + s2 : mm + ':' + s2;
}

/** Подгруженные куски как доли длительности: [[0, .2], [.5, .6]] — для подсветки на полосе. */
export function bufferedParts(ranges, duration) {
  if (!ranges || !(duration > 0)) return [];
  var out = [];
  for (var i = 0; i < ranges.length; i++) {
    var a = Math.max(0, ranges.start(i) / duration), b = Math.min(1, ranges.end(i) / duration);
    if (b > a) out.push([a, b]);
  }
  return out;
}

/** Действие по клавише (или null — не наша). */
export function keyAction(key) {
  switch (key) {
    case ' ': case 'k': case 'K': case 'л': case 'Л': return 'toggle';
    case 'ArrowLeft': return 'back';
    case 'ArrowRight': return 'forward';
    case 'ArrowUp': return 'louder';
    case 'ArrowDown': return 'quieter';
    case 'm': case 'M': case 'ь': case 'Ь': return 'mute';
    case 'f': case 'F': case 'а': case 'А': return 'fullscreen';
    default: return null;
  }
}

function load(key, def) { try { var v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* приватный режим */ } }

/**
 * props: src, poster, autoPlay, videoRef (ref на <video> — для восстановления ссылки и смены качества снаружи),
 * onLoadedMetadata, qualities [{ label }], quality (индекс), onQuality(i).
 */
export function VideoPlayer(props) {
  var wrap = useRef(null), video = useRef(null), fill = useRef(null), knob = useRef(null), timeEl = useRef(null), hover = useRef(null), track = useRef(null);
  var st = useState({ playing: false, waiting: false, duration: 0, buffered: [], shown: true, menu: false, full: false, pip: false, dragging: false });
  var s = st[0];
  var vol = useState(function () { return { volume: load(VOL_KEY, 1), muted: load(MUTE_KEY, false) }; });
  var rate = useState(function () { return player.playerState().rate || 1; });
  var hideTimer = useRef(0), clickTimer = useRef(0), drag = useRef(null), raf = useRef(0);
  function set(p) { st[1](function (o) { for (var k in p) if (o[k] !== p[k]) return Object.assign({}, o, p); return o; }); }
  var spinner = useMinVisible(s.waiting, { delay: 300, min: 500 });

  // смена качества — новый <video> (key): старый отпускает ref уже после того, как новый его взял, — null не пишем
  function attach(n) {
    if (!n) return;
    video.current = n;
    if (props.videoRef) { if (typeof props.videoRef === 'function') props.videoRef(n); else props.videoRef.current = n; }
  }

  // громкость и скорость — в самом элементе (переживают смену качества: новый <video> получает их при монтировании)
  useEffect(function () { var v = video.current; if (!v) return; v.volume = vol[0].volume; v.muted = vol[0].muted; }, [vol[0], props.src]);
  useEffect(function () { var v = video.current; if (v) v.playbackRate = rate[0]; }, [rate[0], props.src]);

  // кадр: полоса и время — прямо в DOM
  useEffect(function () {
    function tick() {
      raf.current = requestAnimationFrame(tick);
      var v = video.current;
      if (!v) return;
      var d = v.duration || 0;
      var t = drag.current ? drag.current.t : v.currentTime;
      var p = d > 0 ? Math.min(1, t / d) : 0;
      if (fill.current) fill.current.style.transform = 'scaleX(' + p + ')';
      if (knob.current) knob.current.style.left = (p * 100) + '%';
      if (timeEl.current) { var txt = fmtTime(t) + ' / ' + fmtTime(d); if (timeEl.current.textContent !== txt) timeEl.current.textContent = txt; }
      if (track.current) { track.current.setAttribute('aria-valuenow', String(Math.round(t))); track.current.setAttribute('aria-valuetext', fmtTime(t)); }
    }
    raf.current = requestAnimationFrame(tick);
    return function () { cancelAnimationFrame(raf.current); };
  }, []);

  // события элемента
  useEffect(function () {
    var v = video.current;
    if (!v) return undefined;
    var on = function (type, fn) { v.addEventListener(type, fn); return function () { v.removeEventListener(type, fn); }; };
    var offs = [
      on('play', function () { set({ playing: true }); poke(); }),
      on('pause', function () { set({ playing: false, shown: true }); }),
      on('waiting', function () { set({ waiting: true }); }),
      on('playing', function () { set({ waiting: false }); }),
      on('canplay', function () { set({ waiting: false }); }),
      on('seeked', function () { set({ waiting: false }); }),
      on('durationchange', function () { set({ duration: v.duration || 0 }); }),
      on('progress', function () { st[1](function (o) { return Object.assign({}, o, { buffered: bufferedParts(v.buffered, v.duration) }); }); }),
      on('enterpictureinpicture', function () { set({ pip: true }); }),
      on('leavepictureinpicture', function () { set({ pip: false }); }),
    ];
    set({ duration: v.duration || 0, playing: !v.paused });
    return function () { offs.forEach(function (f) { f(); }); };
  }, [props.src]);

  useEffect(function () {
    var onFs = function () { set({ full: document.fullscreenElement === wrap.current }); };
    document.addEventListener('fullscreenchange', onFs);
    return function () { document.removeEventListener('fullscreenchange', onFs); clearTimeout(hideTimer.current); clearTimeout(clickTimer.current); };
  }, []);

  // панель: показать и, если видео играет, спрятать через HIDE_MS без движения
  function poke() {
    set({ shown: true });
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(function () {
      var v = video.current;
      if (v && !v.paused && !drag.current) st[1](function (o) { return o.menu ? o : Object.assign({}, o, { shown: false }); });
    }, HIDE_MS);
  }

  function toggle() { var v = video.current; if (!v) return; if (v.paused || v.ended) v.play().catch(function () {}); else v.pause(); poke(); }
  function seekBy(d) { var v = video.current; if (!v || !v.duration) return; v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + d)); poke(); }
  function setVolume(x) {
    x = Math.max(0, Math.min(1, x));
    var next = { volume: x || vol[0].volume, muted: x === 0 };
    vol[1](next); save(VOL_KEY, next.volume); save(MUTE_KEY, next.muted);
  }
  function toggleMute() {
    var next = { volume: vol[0].volume || 1, muted: !vol[0].muted };
    vol[1](next); save(MUTE_KEY, next.muted); save(VOL_KEY, next.volume);
  }
  function setRate(r) { rate[1](r); player.setRate(r); }   // одна скорость с голосовыми, как в Telegram
  function fullscreen() {
    var w = wrap.current;
    if (!w) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    else if (w.requestFullscreen) w.requestFullscreen().catch(function () {});
    poke();
  }
  function pip() {
    var v = video.current;
    if (!v || !document.pictureInPictureEnabled) return;
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
    else v.requestPictureInPicture().catch(function () {});
  }

  // клавиши — где бы ни был фокус (просмотрщик стрелками в видео не листает)
  useEffect(function () {
    var onKey = function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var a = keyAction(e.key);
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      var v = video.current;
      if (a === 'toggle') toggle();
      else if (a === 'back') seekBy(-SEEK_STEP);
      else if (a === 'forward') seekBy(SEEK_STEP);
      else if (a === 'louder') setVolume((vol[0].muted ? 0 : vol[0].volume) + VOLUME_STEP);
      else if (a === 'quieter') setVolume((vol[0].muted ? 0 : vol[0].volume) - VOLUME_STEP);
      else if (a === 'mute') toggleMute();
      else if (a === 'fullscreen') fullscreen();
      if (v && a !== 'toggle') poke();
    };
    addEventListener('keydown', onKey, true);
    return function () { removeEventListener('keydown', onKey, true); };
  });

  // клик по кадру — пауза, двойной — во весь экран
  function onVideoClick(e) {
    e.stopPropagation();
    if (s.menu) { set({ menu: false }); return; }
    clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(toggle, CLICK_MS);
  }
  function onVideoDbl(e) { e.stopPropagation(); clearTimeout(clickTimer.current); fullscreen(); }

  // полоса: нажал — сразу туда, тянешь — видно место и время, отпустил — перемотка
  function fraction(e) {
    var r = track.current.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  }
  function onDown(e) {
    var v = video.current;
    if (!v || !v.duration || e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    track.current.setPointerCapture(e.pointerId);
    drag.current = { t: fraction(e) * v.duration, resume: !v.paused };
    v.pause();
    set({ dragging: true });
  }
  function onMove(e) {
    var v = video.current;
    if (!v || !v.duration) return;
    var f = fraction(e);
    if (hover.current) { hover.current.style.left = (f * 100) + '%'; hover.current.textContent = fmtTime(f * v.duration); }
    if (drag.current) { drag.current.t = f * v.duration; if (v.fastSeek) v.fastSeek(drag.current.t); }
    poke();
  }
  function onUp(e) {
    var v = video.current, d = drag.current;
    if (!d) return;
    drag.current = null;
    try { track.current.releasePointerCapture(e.pointerId); } catch (err) { /* уже отпущен */ }
    if (v) { v.currentTime = d.t; if (d.resume) v.play().catch(function () {}); }
    set({ dragging: false });
  }

  var qs = props.qualities && props.qualities.length > 1 ? props.qualities : null;
  var volLevel = vol[0].muted ? 0 : vol[0].volume;
  var shown = s.shown || !s.playing || s.menu || s.dragging;
  var pct = function (x) { return (x * 100).toFixed(3) + '%'; };

  return h('div', { ref: wrap, class: cx('rl-vp', !shown && 'rl-vp-idle', s.full && 'rl-vp-full'),
      onMouseMove: poke, onTouchStart: poke, onClick: function (e) { e.stopPropagation(); } },
    h('video', { key: props.src, ref: attach, class: 'rl-vp-video', src: props.src, poster: props.poster || undefined, autoPlay: props.autoPlay !== false, playsInline: true,
      onLoadedMetadata: props.onLoadedMetadata, onClick: onVideoClick, onDblClick: onVideoDbl }),
    // большая кнопка по центру — на паузе
    h('button', { type: 'button', class: cx('rl-vp-center', (!s.playing && !spinner) && 'rl-vp-center-on'), tabIndex: s.playing ? -1 : 0,
      'aria-label': 'Воспроизвести', onClick: function (e) { e.stopPropagation(); toggle(); } }, h(Icon, { name: 'play', size: 32 })),
    h('div', { class: cx('rl-vp-spin', spinner && 'rl-vp-spin-on'), 'aria-hidden': spinner ? undefined : 'true' }, h(ProgressRing, { size: 48, onMedia: true, label: 'Загрузка видео' })),
    s.menu ? h('div', { class: 'rl-vp-menu', role: 'menu', onClick: function (e) { e.stopPropagation(); } },
      h('div', { class: 'rl-vp-menu-title' }, 'Скорость'),
      h('div', { class: 'rl-vp-chips' }, SPEEDS.map(function (r) {
        return h('button', { key: r, type: 'button', role: 'menuitemradio', 'aria-checked': rate[0] === r ? 'true' : 'false', class: cx('rl-vp-chip', rate[0] === r && 'rl-vp-chip-on'),
          onClick: function () { setRate(r); } }, (r === 1 ? 'Обычная' : String(r).replace('.', ',') + '×'));
      })),
      qs ? h('div', { class: 'rl-vp-menu-title' }, 'Качество') : null,
      qs ? h('div', { class: 'rl-vp-chips' }, qs.map(function (q, i) {
        return h('button', { key: q.label, type: 'button', role: 'menuitemradio', 'aria-checked': props.quality === i ? 'true' : 'false', class: cx('rl-vp-chip', props.quality === i && 'rl-vp-chip-on'),
          onClick: function () { if (props.quality !== i && props.onQuality) props.onQuality(i); set({ menu: false }); } }, q.label);
      })) : null) : null,
    h('div', { class: 'rl-vp-bar', onClick: function (e) { e.stopPropagation(); } },
      h('div', { ref: track, class: cx('rl-vp-track', s.dragging && 'rl-vp-track-drag'), role: 'slider', tabIndex: -1, 'aria-label': 'Перемотка',
          'aria-valuemin': 0, 'aria-valuemax': Math.round(s.duration),
          onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp },
        h('div', { class: 'rl-vp-rail' },
          s.buffered.map(function (b, i) { return h('span', { key: i, class: 'rl-vp-buf', style: { left: pct(b[0]), width: pct(b[1] - b[0]) } }); }),
          h('span', { ref: fill, class: 'rl-vp-fill' })),
        h('span', { ref: knob, class: 'rl-vp-knob' }),
        h('span', { ref: hover, class: 'rl-vp-hover', 'aria-hidden': 'true' })),
      h('div', { class: 'rl-vp-row' },
        h('button', { type: 'button', class: 'rl-vp-btn', 'aria-label': s.playing ? 'Пауза' : 'Воспроизвести', onClick: toggle }, h(Icon, { name: s.playing ? 'pause' : 'play', size: 22 })),
        h('div', { class: 'rl-vp-vol' },
          h('button', { type: 'button', class: 'rl-vp-btn', 'aria-label': vol[0].muted ? 'Включить звук' : 'Выключить звук', onClick: toggleMute },
            h(Icon, { name: volLevel === 0 ? 'volumeOff' : volLevel < 0.5 ? 'volumeLow' : 'volume', size: 22 })),
          h('input', { type: 'range', class: 'rl-vp-range', min: 0, max: 1, step: 0.05, value: volLevel, 'aria-label': 'Громкость',
            style: { '--vp-vol': pct(volLevel) }, onInput: function (e) { setVolume(Number(e.currentTarget.value)); } })),
        h('span', { ref: timeEl, class: 'rl-vp-time' }, '0:00 / ' + fmtTime(s.duration)),
        h('span', { class: 'rl-vp-gap' }),
        h('button', { type: 'button', class: cx('rl-vp-btn', 'rl-vp-text', s.menu && 'rl-vp-btn-on'), 'aria-label': 'Скорость и качество', 'aria-haspopup': 'menu', 'aria-expanded': s.menu ? 'true' : 'false',
          onClick: function () { set({ menu: !s.menu }); poke(); } },
          rate[0] === 1 ? h(Icon, { name: 'settings', size: 20 }) : String(rate[0]).replace('.', ',') + '×'),
        typeof document !== 'undefined' && document.pictureInPictureEnabled
          ? h('button', { type: 'button', class: cx('rl-vp-btn', s.pip && 'rl-vp-btn-on'), 'aria-label': 'Картинка в картинке', onClick: pip }, h(Icon, { name: 'pip', size: 22 })) : null,
        h('button', { type: 'button', class: 'rl-vp-btn', 'aria-label': s.full ? 'Выйти из полноэкранного режима' : 'Во весь экран', onClick: fullscreen },
          h(Icon, { name: s.full ? 'collapse' : 'expand', size: 20 })))));
}
