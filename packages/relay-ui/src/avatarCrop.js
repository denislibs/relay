// Обрезка фото профиля: квадрат со скруглённой рамкой-кругом, фото двигается пальцем/мышью и масштабируется
// (колесо, ползунок, щипок двумя пальцами). Фото всегда накрывает круг — пустых краёв не бывает.
// onDone получает три картинки: big (640, JPEG), small (160, JPEG) и thumb — крошечное data:URL-превью,
// которое показывается размытым, пока грузится настоящее фото.
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Button, cx } from './kit.js';
import { Modal } from './modal.js';

var MAX_ZOOM = 3;

function canvasOf(size) { var c = document.createElement('canvas'); c.width = c.height = size; return c; }
function toBlob(c, q) { return new Promise(function (ok, no) { c.toBlob(function (b) { if (b) ok(b); else no(new Error('toBlob')); }, 'image/jpeg', q); }); }

/** Вырезать квадрат (sx, sy, side — в пикселях исходника) и ужать до 640/160 и превью 16×16. */
export async function cropAvatar(img, sx, sy, side) {
  var big = canvasOf(640), g = big.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 640);   // прозрачный PNG в JPEG — на белом, а не на чёрном
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, sx, sy, side, side, 0, 0, 640, 640);
  var small = canvasOf(160), s = small.getContext('2d');
  s.imageSmoothingQuality = 'high';
  s.drawImage(big, 0, 0, 160, 160);
  var tiny = canvasOf(16);
  tiny.getContext('2d').drawImage(small, 0, 0, 16, 16);
  return { big: await toBlob(big, 0.9), small: await toBlob(small, 0.88), thumb: tiny.toDataURL('image/jpeg', 0.6) };
}

export function AvatarCropper(props) {
  var stage = Math.max(220, Math.min(360, (typeof innerWidth === 'number' ? innerWidth : 400) - 64));
  var img = useRef(null), st = useRef(null), ptrs = useRef(new Map()), pinch = useRef(null);
  var view = useState(null);   // { x, y, scale, base } — левый верх фото в рамке и масштаб
  var zoom = useState(1), busy = useState(false);
  var v = view[0];

  function clamp(x, y, scale, iw, ih) {
    var w = iw * scale, hh = ih * scale;
    return { x: Math.min(0, Math.max(stage - w, x)), y: Math.min(0, Math.max(stage - hh, y)) };
  }
  function setZoom(z, cx0, cy0) {
    var el = img.current, cur = st.current;
    if (!el || !cur) return;
    z = Math.min(MAX_ZOOM, Math.max(1, z));
    var scale = cur.base * z;
    var px = cx0 == null ? stage / 2 : cx0, py = cy0 == null ? stage / 2 : cy0;
    // точка под пальцем/центром остаётся на месте
    var ix = (px - cur.x) / cur.scale, iy = (py - cur.y) / cur.scale;
    var p = clamp(px - ix * scale, py - iy * scale, scale, el.naturalWidth, el.naturalHeight);
    st.current = { x: p.x, y: p.y, scale: scale, base: cur.base };
    zoom[1](z); view[1](st.current);
  }
  function onLoad() {
    var el = img.current, iw = el.naturalWidth, ih = el.naturalHeight;
    var base = Math.max(stage / iw, stage / ih);
    st.current = { x: (stage - iw * base) / 2, y: (stage - ih * base) / 2, scale: base, base: base };
    view[1](st.current);
  }
  useLayoutEffect(function () { var el = img.current; if (el && el.complete && el.naturalWidth) onLoad(); }, [props.src]);

  function down(e) {
    if (!st.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2) { var a = [...ptrs.current.values()]; pinch.current = { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), z: zoom[0] }; }
  }
  function move(e) {
    var prev = ptrs.current.get(e.pointerId), cur = st.current, el = img.current;
    if (!prev || !cur || !el) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2 && pinch.current) {
      var a = [...ptrs.current.values()], r = e.currentTarget.getBoundingClientRect();
      setZoom(pinch.current.z * Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) / pinch.current.d, (a[0].x + a[1].x) / 2 - r.left, (a[0].y + a[1].y) / 2 - r.top);
      return;
    }
    var p = clamp(cur.x + e.clientX - prev.x, cur.y + e.clientY - prev.y, cur.scale, el.naturalWidth, el.naturalHeight);
    st.current = { x: p.x, y: p.y, scale: cur.scale, base: cur.base };
    view[1](st.current);
  }
  function up(e) { ptrs.current.delete(e.pointerId); if (ptrs.current.size < 2) pinch.current = null; }
  function wheel(e) {
    e.preventDefault();
    var r = e.currentTarget.getBoundingClientRect();
    setZoom(zoom[0] * Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
  }
  // колесо — с passive: false, иначе preventDefault не сработает и прокрутится страница
  var frame = useRef(null);
  useEffect(function () {
    var el = frame.current;
    if (!el) return;
    el.addEventListener('wheel', wheel, { passive: false });
    return function () { el.removeEventListener('wheel', wheel); };
  });

  async function done() {
    var cur = st.current, el = img.current;
    if (!cur || !el || busy[0]) return;
    busy[1](true);
    try { props.onDone(await cropAvatar(el, -cur.x / cur.scale, -cur.y / cur.scale, stage / cur.scale)); }
    catch (err) { busy[1](false); if (props.onError) props.onError(err); }
  }

  return h(Modal, { open: true, title: props.title || 'Фото профиля', size: 'slim', onClose: props.onClose, className: 'rl-crop-modal',
    actions: [
      h(Button, { key: 'c', variant: 'ghost', onClick: props.onClose }, 'Отмена'),
      h(Button, { key: 'd', disabled: !v || busy[0], onClick: done }, busy[0] ? 'Готовлю…' : 'Готово'),
    ] },
    h('div', { ref: frame, class: cx('rl-crop', !v && 'is-loading'), style: { width: stage, height: stage }, onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up },
      h('img', { ref: img, src: props.src, alt: '', draggable: false, onLoad: onLoad,
        style: v ? { transform: 'translate3d(' + v.x + 'px,' + v.y + 'px,0) scale(' + v.scale + ')' } : null }),
      h('div', { class: 'rl-crop-mask', 'aria-hidden': 'true' })),
    h('input', { class: 'rl-crop-zoom', type: 'range', min: 1, max: MAX_ZOOM, step: 0.01, value: zoom[0], 'aria-label': 'Масштаб',
      onInput: function (e) { setZoom(Number(e.currentTarget.value)); } }),
    h('p', { class: 'rl-crop-hint' }, 'Перетащите фото, чтобы выбрать, что попадёт в круг'));
}
