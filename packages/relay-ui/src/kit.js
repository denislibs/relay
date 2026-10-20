import { h, Fragment, toChildArray, createContext } from 'preact';
import { useState, useRef, useEffect, useLayoutEffect, useContext } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { MentionList } from './more.js';
import { PACK_ICONS, PACK_FILLED } from './iconPack.js';
import { requestMeasure, requestMutation, beginHeavyAnimation, onHeavyAnimationEnd, isHeavyAnimating, forceMeasure } from './schedule.js';
import { VideoPlayer } from './media/videoPlayer.js';

/* Relay UI kit — Preact. Ported 1:1 from the original kit; see index.js for the public surface. */


function cx() {
  var out = [];
  for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
  return out.join(' ');
}
/* ---------- Motion helpers ---------- */
// Система просит меньше движения ИЛИ в настройках выключены анимации интерфейса (data-anim="0" на <html>).
function reducedMotion() {
  if (document.documentElement.dataset.anim === '0') return true;
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function chain(a, b) { return function (e) { if (a) a(e); if (b) b(e); }; }
// Pointer ripple: one measure (rect) then one mutation (append), in that order — the fasterdom rule.
/* Ripple — круг из точки нажатия. Диаметр — до дальнего угла элемента, так что к концу роста он
   закрывает всё; рост плавный и не прерывается. Отпустили рано — круг дорастает почти до конца и
   только потом гаснет: короткий клик не «мигает». Цвет нейтральный (--ripple), не цвет текста. */
var RIPPLE_MS = 600, RIPPLE_FADE_MS = 300;
function ripple(e) {
  var el = e.currentTarget;
  if (!el || el.disabled || reducedMotion() || (e.button != null && e.button !== 0)) return;
  var x = e.clientX, y = e.clientY, start = performance.now(), dot = null, releasedAt = 0;
  function fade() {
    if (!dot) return;
    var d = dot; dot = null;
    requestMutation(function () { d.classList.add('rl-ripple-out'); setTimeout(function () { d.remove(); }, RIPPLE_FADE_MS + 40); });
  }
  function done() {
    window.removeEventListener('pointerup', done); window.removeEventListener('pointercancel', done);
    releasedAt = performance.now();
    if (dot) setTimeout(fade, Math.max(0, RIPPLE_MS * 0.55 - (releasedAt - start)));
  }
  window.addEventListener('pointerup', done); window.addEventListener('pointercancel', done);
  // замер — в фазе чтения, вставка — в фазе записи того же кадра
  requestMeasure(function () {
    var r = el.getBoundingClientRect();
    requestMutation(function () {
      var host = el.querySelector(':scope > .rl-ripple-host');
      if (!host) { host = document.createElement('span'); host.className = 'rl-ripple-host'; el.appendChild(host); }
      var cx = x - r.left, cy = y - r.top;
      var d = 2 * Math.hypot(Math.max(cx, r.width - cx), Math.max(cy, r.height - cy));
      dot = document.createElement('span');
      dot.className = 'rl-ripple';
      dot.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (cx - d / 2) + 'px;top:' + (cy - d / 2) + 'px';
      host.appendChild(dot);
      if (releasedAt) setTimeout(fade, Math.max(0, RIPPLE_MS * 0.55 - (releasedAt - start)));
    });
  });
}

function omit(obj, keys) {
  var out = {};
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && keys.indexOf(k) < 0) out[k] = obj[k];
  return out;
}

/* ---------- Icon: 24px grid, 1.8 stroke, currentColor ---------- */
var C = function (cx_, cy, r) { return 'M' + (cx_ - r) + ' ' + cy + 'a' + r + ' ' + r + ' 0 1 0 ' + (2 * r) + ' 0a' + r + ' ' + r + ' 0 1 0 ' + (-2 * r) + ' 0'; };
var ICONS = {
  search: [C(11, 11, 7), 'M20 20l-3.5-3.5'],
  more: ['M12 5h.01', 'M12 12h.01', 'M12 19h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  chats: ['M4 5h16v11H9l-5 4z', 'M8 9h8', 'M8 12h5'],
  phone: ['M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2'],
  status: ['M12 3a9 9 0 1 1-9 9', 'M3.5 8.5a9 9 0 0 1 5-5', C(12, 12, 4)],
  channels: ['M4 10v4', 'M10 7l9-3v16l-9-3H7V7z'],
  community: [C(9, 8, 3.5), 'M2 20a7 7 0 0 1 14 0', 'M16 4.5a3.5 3.5 0 0 1 0 7', 'M18 14a6 6 0 0 1 4 6'],
  archive: ['M3 5h18v4H3z', 'M5 9v10h14V9', 'M12 12v5', 'M9.5 14.5L12 17l2.5-2.5'],
  send: ['M4 12l16-8-6 16-3-7z', 'M11 13l9-9'],
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'],
  smile: [C(12, 12, 9), 'M8.5 14.5a4.5 4.5 0 0 0 7 0', 'M9 9.5h.01', 'M15 9.5h.01'],
  attach: ['M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-8'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  clock: [C(12, 12, 9), 'M12 7v5l3 2'],
  alert: [C(12, 12, 9), 'M12 8v5', 'M12 16h.01'],
  info: [C(12, 12, 9), 'M12 11v5', 'M12 8h.01'],
  skipPrev: ['M11.5 7l-6 5 6 5z', 'M19 7l-6 5 6 5z'],
  skipNext: ['M4.5 7l6 5-6 5z', 'M12.5 7l6 5-6 5z'],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
  volume: ['M4 9.5h3.5L12 5.5v13l-4.5-4H4z', 'M15.5 9a4 4 0 0 1 0 6', 'M18 6.5a7.5 7.5 0 0 1 0 11'],
  volumeOff: ['M4 9.5h3.5L12 5.5v13l-4.5-4H4z', 'M16 9.5l5 5', 'M21 9.5l-5 5'],
  volumeLow: ['M4 9.5h3.5L12 5.5v13l-4.5-4H4z', 'M15.5 9a4 4 0 0 1 0 6'],
  repeat: ['M17 3l3 3-3 3', 'M4 11V9a3 3 0 0 1 3-3h13', 'M7 21l-3-3 3-3', 'M20 13v2a3 3 0 0 1-3 3H4'],
  repeatOne: ['M17 3l3 3-3 3', 'M4 11V9a3 3 0 0 1 3-3h13', 'M7 21l-3-3 3-3', 'M20 13v2a3 3 0 0 1-3 3H4', 'M11 10.5l1.2-.7v4.6'],
  shuffle: ['M16 4h4v4', 'M4 20L20 4', 'M20 16v4h-4', 'M14.5 14.5L20 20', 'M4 4l5 5'],
  order: ['M7 4v16', 'M4 17l3 3 3-3', 'M17 20V4', 'M14 7l3-3 3 3'],
  music: ['M9 18V6l11-2.5V16', 'M9 18a3 3 0 1 1-3-3h3', 'M20 16a3 3 0 1 1-3-3h3'],
  musicAdd: ['M9 18V6l9-2v6', 'M9 18a2.5 2.5 0 1 1-2.5-2.5H9', 'M18 14v6', 'M15 17h6'],
  musicRemove: ['M9 18V6l9-2v6', 'M9 18a2.5 2.5 0 1 1-2.5-2.5H9', 'M15 17h6'],
  newTab: ['M8 4h9a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z', 'M12.5 8.5v7', 'M9 12h7'],
  markRead: ['M12 20a8 8 0 1 0-7.1-4.3L4 20l4.4-.9A8 8 0 0 0 12 20z', 'M8.5 12.2l2.4 2.4 4.6-4.9'],
  bellOff: ['M6.3 6.3A6 6 0 0 0 6 8v4l-2 4h12', 'M9 4a6 6 0 0 1 9 5v3l1 2', 'M10 20a2 2 0 0 0 4 0', 'M3 3l18 18'],
  lock: ['M6 11h12v10H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  download: ['M12 4v11', 'M7.5 10.5L12 15l4.5-4.5', 'M5 20h14'],
  chevronRight: ['M9 6l6 6-6 6'],
  logout: ['M10 4H5v16h5', 'M15 8l4 4-4 4', 'M19 12H9'],
  arrowLeft: ['M19 12H5', 'M11 6l-6 6 6 6'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  arrowDown: ['M12 5v14', 'M6 13l6 6 6-6'],
  external: ['M8 16L16 8', 'M9 8h7v7'],
  video: ['M3 7h12v10H3z', 'M15 10.5l6-3.5v10l-6-3.5'],
  mail: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
  palette: ['M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h2a4 4 0 0 0 4-4c0-4.4-4-8-9-8', 'M7.5 11h.01', 'M10 7h.01', 'M15 7.5h.01'],
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l3 2'],
  wifiOff: ['M2 2l20 20', 'M8.5 16.5a5 5 0 0 1 7 0', 'M5 12.9a10 10 0 0 1 5.2-2.7', 'M16.7 10.2A10 10 0 0 1 19 12.9', 'M2 8.8a15 15 0 0 1 4.2-2.6', 'M10.7 5a15 15 0 0 1 11.3 3.8', 'M12 20h.01'],
  image: ['M3 5h18v14H3z', C(9, 10, 2), 'M21 16l-5-5L5 19'],
  play: ['M7 5v14l12-7z'],
  pause: ['M8 5v14', 'M16 5v14'],
  stop: ['M7 7h10v10H7z'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  star: ['M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z'],
  reply: ['M10 7L4 12l6 5', 'M4 12h10a6 6 0 0 1 6 6'],
  forward: ['M14 7l6 5-6 5', 'M20 12H10a6 6 0 0 0-6 6'],
  zoomIn: [C(11, 11, 7), 'M20 20l-3.5-3.5', 'M11 8v6', 'M8 11h6'],
  chevronLeft: ['M15 6l-6 6 6 6'],
  chevronDown: ['M6 9l6 6 6-6'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  chevronUp: ['M6 15l6-6 6 6'],
  pin: ['M9 4h6l-1 6 3 3H7l3-3z', 'M12 13v7'],
  ban: [C(12, 12, 9), 'M5.6 5.6l12.8 12.8'],
  camera: ['M4 8h3l2-3h6l2 3h3v11H4z', C(12, 13, 3.5)],
  contact: [C(12, 9, 3.5), 'M5 20a7 7 0 0 1 14 0'],
  poll: ['M5 20V10', 'M12 20V4', 'M19 20v-7'],
  sticker: ['M20 12a8 8 0 1 1-8-8h8z', 'M20 12h-5a3 3 0 0 1-3-3V4'],
  phoneIn: ['M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2', 'M20 4l-5 5', 'M15 5v4h4'],
  phoneOut: ['M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2', 'M15 9l5-5', 'M16 4h4v4'],
  settings: [C(12, 12, 3), 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M4.9 4.9l2.1 2.1', 'M17 17l2.1 2.1', 'M4.9 19.1L7 17', 'M17 7l2.1-2.1'],
  copy: ['M8 8h12v12H8z', 'M4 16V4h12'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  eyeOff: ['M3 3l18 18', 'M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2', 'M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
  key: ['M14.5 3a6.5 6.5 0 0 0-6.2 8.5L3 16.8V21h4v-2.5h2.5V16h2.2l1.3-1.3A6.5 6.5 0 1 0 14.5 3z', 'M16 8.5h.01'],
  qr: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h2v2h-2z', 'M18 18h2v2h-2z', 'M14 18h2', 'M18 14h2'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  redo: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'],
  code: ['M8 7l-5 5 5 5', 'M16 7l5 5-5 5', 'M13.5 4.5l-3 15'],
  heading: ['M6 5v14', 'M18 5v14', 'M6 12h12'],
  quote: ['M5 6v12', 'M10 8h9', 'M10 12h9', 'M10 16h6'],
  divider: ['M4 12h16', 'M8 7h8', 'M8 17h8'],
  text: ['M5 6h14', 'M12 6v13', 'M9 19h6'],
  expand: ['M14 4h6v6', 'M20 4l-7 7', 'M10 20H4v-6', 'M4 20l7-7'],
  pip: ['M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z', 'M12.5 12h5v4.5h-5z'],
  collapse: ['M4 14h6v6', 'M4 20l6-6', 'M20 10h-6V4', 'M20 4l-6 6'],
  article: ['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 12h7', 'M9 16h7'],
  listOrdered: ['M10 6h10', 'M10 12h10', 'M10 18h10', 'M4 5l1.5-1v5', 'M4 15.5a1.5 1.5 0 0 1 3 0c0 1.5-3 2.5-3 3.5h3'],
  cloud: ['M7 19h10.5a4.5 4.5 0 0 0 .6-8.96A6.5 6.5 0 0 0 5.6 9.6 4.75 4.75 0 0 0 7 19z'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
  pencil: ['M4 20l1-5L16 4l4 4L9 19z', 'M14 6l4 4'],
  userPlus: [C(9, 8, 3.5), 'M2 20a7 7 0 0 1 14 0', 'M19 8v6', 'M16 11h6'],
  users: [C(9, 8, 3.5), 'M2 20a7 7 0 0 1 14 0', 'M16 4.5a3.5 3.5 0 0 1 0 7', 'M18 14a6 6 0 0 1 4 6'],
  userCheck: [C(9, 8, 3.5), 'M2 20a7 7 0 0 1 14 0', 'M16 11l2 2 4-4'],
  userX: [C(9, 8, 3.5), 'M2 20a7 7 0 0 1 14 0', 'M17 8l4 4', 'M21 8l-4 4'],
  userMinus: [C(9, 8, 3.5), 'M2 20a7 7 0 0 1 14 0', 'M16 11h6'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  crown: ['M4 18h16', 'M4 15L3 7l5 4 4-6 4 6 5-4-1 8z'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 20a2 2 0 0 0 4 0'],
  timer: ['M12 21a9 9 0 1 0-9-9', 'M12 7v5l3 2', 'M3 16h.01', 'M5.5 19.5h.01'],
  shield: ['M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z'],
  upload: ['M12 20V9', 'M7.5 13.5L12 9l4.5 4.5', 'M5 4h14'],
  account: [C(12, 12, 9), C(12, 10, 3), 'M6.5 18.5a6 6 0 0 1 11 0'],
  general: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 4.5v5', 'M9 14.5v5'],
  storage: ['M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3', 'M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6'],
  folder: ['M3 6h6l2 2.5h10V19H3z'],
  // иконки папок (эмодзи папки → монохромный значок, как в Telegram)
  checkCircle: [C(12, 12, 9), 'M8 12.5l3 3 5-6'],
  briefcase: ['M3.5 8h17v11h-17z', 'M9 8V5.5h6V8', 'M3.5 13h17'],
  home: ['M4 11l8-7 8 7', 'M6 9.5V20h12V9.5', 'M10 20v-5h4v5'],
  heart: ['M12 20s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.4 4.2 4.2 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z'],
  graduation: ['M2.5 9L12 4.5 21.5 9 12 13.5z', 'M6.5 11v4.5c3 2.5 8 2.5 11 0V11', 'M21.5 9v4.5'],
  gamepad: ['M7.5 7.5h9a4 4 0 0 1 4 3.6l.5 4.6a2.4 2.4 0 0 1-4.3 1.7L14.5 15h-5l-2.2 2.4A2.4 2.4 0 0 1 3 15.7l.5-4.6a4 4 0 0 1 4-3.6z', 'M8 10v3', 'M6.5 11.5h3', 'M15.5 10.5h.01', 'M17 12.5h.01'],
  plane: ['M9.5 13.5L4 12l-1.5 1.5 6 2.5 2.5 6 1.5-1.5-1.5-5.5 4-4 3 7 1.5-1.5-1.5-8.5 2.5-2.5a1.6 1.6 0 0 0-2.3-2.3l-2.5 2.5-8.5-1.5L5 7.5l7 3z'],
  cart: ['M3 4h2.5l2.2 10.5h10.6L20.5 7H6.3', C(9.5, 19, 1.4), C(17, 19, 1.4)],
  bot: ['M5 9h14v10H5z', 'M12 9V6', C(12, 4.5, 1.5), 'M9.5 13h.01', 'M14.5 13h.01', 'M9.5 16h5', 'M2.5 12.5v3', 'M21.5 12.5v3'],
  rocket: ['M12 3c3.5 2 5 5.5 5 9l-2 3H9l-2-3c0-3.5 1.5-7 5-9', C(12, 10, 1.5), 'M9 15l-2.5 3.5', 'M15 15l2.5 3.5', 'M12 15v5'],
  globe: [C(12, 12, 9), 'M3 12h18', 'M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3'],
  devices: ['M3 5h14v10H3z', 'M1 19h18', 'M15 9h6v10h-6z'],
  bug: ['M8 11a4 4 0 0 1 8 0v3a4 4 0 0 1-8 0z', 'M9.5 7.6a2.5 2.5 0 0 1 5 0', 'M12 11v7', 'M8 12.5H4.5', 'M16 12.5h3.5', 'M8.3 16.5l-3 2', 'M15.7 16.5l3 2', 'M8.6 9.2L5.5 7.5', 'M15.4 9.2l3.1-1.7', 'M10.4 5.4L9 3.6', 'M13.6 5.4L15 3.6'],
  laptop: ['M5 5h14v10H5z', 'M2 19h20'],
  smartphone: ['M7 3h10v18H7z', 'M11 18h2'],
  at: [C(12, 12, 3.5), 'M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8'],
  cake: ['M4 12h16v8H4z', 'M4 15.5c2 1.5 3 1.5 4 0s2-1.5 4 0 3 1.5 4 0 2-1.5 4 0', 'M12 12V8', 'M12 3.5c1 1 1.5 1.8 0 3-1.5-1.2-1-2 0-3'],
  block: [C(12, 12, 9), 'M5.6 5.6l12.8 12.8'],
  moon: ['M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a7 7 0 0 0 10.7 10.7z'],
  sun: [C(12, 12, 4), 'M12 2.5v2', 'M12 19.5v2', 'M2.5 12h2', 'M19.5 12h2', 'M5.3 5.3l1.4 1.4', 'M17.3 17.3l1.4 1.4', 'M5.3 18.7l1.4-1.4', 'M17.3 6.7l1.4-1.4'],
  // календарь (дата в тексте)
  calendar: ['M6 4.5h12A2.5 2.5 0 0 1 20.5 7v11a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V7A2.5 2.5 0 0 1 6 4.5z', 'M3.5 9.5h17', 'M8 2.8v3.4', 'M16 2.8v3.4', 'M8 13h.01', 'M12 13h.01', 'M16 13h.01', 'M8 16.5h.01', 'M12 16.5h.01'],
  // копировать изображение: картинка и её копия позади
  copyMedia: ['M8.5 3.5h9a3 3 0 0 1 3 3v9', 'M6 7.5h9.5a2 2 0 0 1 2 2V18a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V10A2.5 2.5 0 0 1 6 7.5z', 'M3.8 17.5l3.7-3.7 3 3 2-2 3 3', 'M12.5 11.2h.01'],
  // без звука: динамик с крестиком
  soundOff: ['M4 9.5h3.5L12 5.5v13l-4.5-4H4z', 'M16 9.5l5 5', 'M21 9.5l-5 5'],
  // видеосообщение (кружок): кадр в круге
  roundVideo: [C(12, 12, 9), 'M8.5 9.5h4.5a1.2 1.2 0 0 1 1.2 1.2v2.6a1.2 1.2 0 0 1-1.2 1.2H8.5a1.2 1.2 0 0 1-1.2-1.2v-2.6a1.2 1.2 0 0 1 1.2-1.2z', 'M14.2 11.3l2.3-1.3v4l-2.3-1.3'],
  // оформление текста (панель над выделением)
  bold: ['M7 5h6a3.5 3.5 0 0 1 0 7H7z', 'M7 12h7a3.5 3.5 0 0 1 0 7H7z'],
  italic: ['M10 5h8', 'M6 19h8', 'M14.5 5l-5 14'],
  underline: ['M7 4v7a5 5 0 0 0 10 0V4', 'M5 20h14'],
  strike: ['M4.5 12h15', 'M16.5 7.5c-.6-1.6-2.3-2.5-4.5-2.5-2.6 0-4.4 1.3-4.4 3.2 0 1.2.7 2.2 2.4 2.8', 'M8 16.4c.7 1.6 2.4 2.6 4.6 2.6 2.7 0 4.5-1.4 4.5-3.4 0-.6-.1-1.1-.4-1.6'],
  mono: ['M8.5 7.5L4 12l4.5 4.5', 'M15.5 7.5L20 12l-4.5 4.5', 'M13.5 5.5l-3 13'],
  spoiler: ['M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M9.5 12a2.5 2.5 0 0 0 5 0', 'M4 4l16 16']
};
var HEAVY = { more: 1, 'M12 16h.01': 1, pause: 1 };
var FILLED = { play: 1, stop: 1 };

function Icon(props) {
  var name = props.name, size = props.size || 20, title = props.title;
  var base = { class: cx('rl-icon', (props.className || props.class)), width: size, height: size, viewBox: '0 0 24 24',
    role: title ? 'img' : undefined, 'aria-label': title, 'aria-hidden': title ? undefined : 'true', 'data-icon': name };
  // залитый вариант (там, где он у Telegram): фигура залита, внутренние детали вырезаны маской
  var filled = PACK_FILLED[name] || (name === 'play' ? PACK_FILLED.playFilled : name === 'pause' ? PACK_FILLED.pauseFilled : name === 'stop' ? PACK_FILLED.stopFilled : null);
  if (filled) {
    // маска зависит только от имени значка — один id на имя (одинаковые маски на странице взаимозаменяемы)
    var id = { current: 'rl-ic-' + name };
    var sw0 = props.strokeWidth || 1.8;
    return h('svg', Object.assign(base, { fill: 'none', stroke: 'currentColor', 'stroke-width': sw0, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      filled.cut ? h('defs', null, h('mask', { id: id.current, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 24, height: 24 },
        h('rect', { width: 24, height: 24, fill: '#fff', stroke: 'none' }),
        filled.cut.map(function (d, i) { return h('path', { key: i, d: d, stroke: '#000', 'stroke-width': sw0 }); }))) : null,
      // заливка — по контуру пака, обводка лишь чуть скругляет углы (с полной обводкой 1.8 фигуры раздувались — «жирные»)
      h('g', { mask: filled.cut ? 'url(#' + id.current + ')' : undefined, fill: 'currentColor', 'stroke-width': 0.5 }, filled.fill.map(function (d, i) { return h('path', { key: i, d: d }); })),
      (filled.extra || []).map(function (d, i) { return h('path', { key: 'x' + i, d: d }); }));
  }
  // пак (Messenger icon pack v3): готовые внутренности SVG
  var pack = PACK_ICONS[name];
  if (pack) return h('svg', Object.assign(base, { fill: 'none', stroke: 'currentColor', 'stroke-width': props.strokeWidth || 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    dangerouslySetInnerHTML: { __html: pack } }));
  var d = ICONS[name] || ICONS.info;
  var sw = props.strokeWidth || (HEAVY[name] ? 3 : 1.8);
  return h('svg', Object.assign(base, { fill: FILLED[name] ? 'currentColor' : 'none',
    stroke: 'currentColor', 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }), d.map(function (p, i) { return h('path', { key: i, d: p }); }));
}
Icon.names = Object.keys(ICONS).concat(Object.keys(PACK_FILLED));

/* ---------- Button ---------- */
function Button(props) {
  var variant = props.variant || 'primary';
  var rest = omit(props, ['variant', 'size', 'icon', 'iconRight', 'className', 'class', 'children']);
  return h('button', Object.assign({ type: 'button' }, rest, { onPointerDown: chain(rest.onPointerDown, ripple),
    class: cx('rl-btn', 'rl-btn-' + variant, props.size === 'lg' && 'rl-btn-lg', (props.className || props.class))
  }),
    props.icon ? h(Icon, { name: props.icon, size: 18 }) : null,
    props.children,
    props.iconRight ? h(Icon, { name: props.iconRight, size: 18 }) : null);
}

/* ---------- IconButton ---------- */
function IconButton(props) {
  var rest = omit(props, ['icon', 'label', 'badge', 'active', 'filled', 'size', 'className', 'class']);
  return h('button', Object.assign({ type: 'button' }, rest, { onPointerDown: chain(rest.onPointerDown, ripple),
    class: cx('rl-iconbtn', props.filled && 'rl-iconbtn-filled', (props.className || props.class)),
    // без title: системная подсказка вылезает за край панели и окна (как в Telegram — подписи нет, есть aria-label)
    'aria-label': props.label,
    'aria-pressed': props.active === undefined ? undefined : String(!!props.active)
  }),
    h(Icon, { name: props.icon, size: props.size || 22 }),
    props.badge ? h(Badge, { count: props.badge }) : null);
}

/* ---------- Avatar ---------- */
function initials(name) {
  if (!name) return '';
  var parts = String(name).trim().split(/\s+/);
  var a = parts[0] ? parts[0][0] : '';
  var b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}
/* Цвет собеседника: 7 оттенков палитры (--peer-0…6). У кого есть id — id % 7, иначе хэш имени. */
var PEER_COLORS = 7;
function peerTone(id) { return Math.abs(Math.trunc(id)) % PEER_COLORS; }
function nameTone(name) {
  var x = 0;
  for (var i = 0; i < name.length; i++) x = (x * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(x) % PEER_COLORS;
}
/* ---------- Знак Relay и значок «официальный» ---------- */
// Свой рисунок: облачко сообщения с двумя встречными стрелками — «передача» (relay). Белым по фирменному градиенту.
var LOGO_PATHS = ['M6 7.5A3.5 3.5 0 0 1 9.5 4h5A3.5 3.5 0 0 1 18 7.5v4a3.5 3.5 0 0 1-3.5 3.5H11l-3.6 3v-3.2A3.5 3.5 0 0 1 6 11.5z', 'M9.6 8.4h4.6l-1.4-1.3', 'M14.4 11h-4.6l1.4 1.3'];
function RelayLogo(props) {
  var size = props.size || 24;
  return h('svg', { class: 'rl-logo-mark', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    LOGO_PATHS.map(function (d, i) {
      return h('path', { key: i, d: d, fill: i === 0 ? '#fff' : 'none', stroke: i === 0 ? 'none' : 'var(--logo-ink)', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    }));
}
/** Значок подтверждённого (официального) аккаунта рядом с именем. size — px. */
function Verified(props) {
  var size = props.size || 16;
  return h('span', { class: cx('rl-verified', props.class), role: 'img', 'aria-label': props.label || 'Официальный аккаунт', title: props.label || 'Официальный аккаунт', style: { width: size, height: size } },
    h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
      h('circle', { cx: 8, cy: 8, r: 8, fill: 'var(--verified)' }),
      h('path', { d: 'M4.6 8.3l2.2 2.2 4.6-4.8', fill: 'none', stroke: '#fff', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
}

function Avatar(props) {
  var size = props.size || 48;
  if (props.logo) {
    // официальный аккаунт: знак вместо инициалов
    return h('span', { class: cx('rl-avatar', 'rl-avatar-logo', (props.className || props.class)), style: { width: size, height: size }, role: 'img', 'aria-label': props.name || 'Relay' },
      h(RelayLogo, { size: Math.round(size * 0.62) }));
  }
  var tone = props.tone != null ? props.tone : props.name ? nameTone(String(props.name)) : null;
  // фото: под ним инициалы и размытое превью (thumb), само фото проявляется, когда загрузилось, —
  // из кэша сразу, без мигания; ошибка загрузки — остаются превью/инициалы
  return h('span', {
    class: cx('rl-avatar', tone != null && 'rl-avatar-tone', props.src && 'rl-avatar-photo', (props.className || props.class)),
    style: { width: size, height: size, fontSize: Math.round(size * 0.36), '--avatar-tone': tone != null ? 'var(--peer-' + tone + '-fill)' : undefined },
    role: 'img', 'aria-label': props.name || 'Аватар'
  },
    props.name ? initials(props.name) : props.src ? null : h(Icon, { name: 'community', size: Math.round(size * 0.5) }),
    props.src && props.thumb ? h('span', { class: 'rl-avatar-thumb', style: { backgroundImage: 'url("' + props.thumb + '")' }, 'aria-hidden': 'true' }) : null,
    props.src ? h('img', { key: props.src, class: 'rl-avatar-img', src: props.src, alt: '', decoding: 'async', draggable: false, ref: avatarImgReady, onLoad: avatarImgLoad }) : null,
    props.online ? h('span', { class: 'rl-avatar-dot', 'aria-hidden': 'true' }) : null);
}
// уже в кэше браузера — показать сразу (без перехода), иначе — по onLoad с плавным проявлением
function avatarImgReady(el) { if (el && el.complete && el.naturalWidth) el.classList.add('is-instant', 'is-ready'); }
function avatarImgLoad(e) { e.currentTarget.classList.add('is-ready'); }

/* ---------- Badge ---------- */
function Badge(props) {
  var dot = props.count === true;
  var label = dot ? '' : (props.count > 999 ? '999+' : String(props.count));
  return h('span', {
    key: label, class: cx('rl-badge', props.muted && 'rl-badge-muted', dot && 'rl-badge-dot', (props.className || props.class)),
    'aria-label': dot ? 'новое' : label + ' непрочитанных'
  }, label);
}

/* ---------- Chip ---------- */
function Chip(props) {
  var rest = omit(props, ['active', 'count', 'children', 'className', 'class']);
  return h('button', Object.assign({ type: 'button' }, rest, { onPointerDown: chain(rest.onPointerDown, ripple),
    class: cx('rl-chip', (props.className || props.class)), 'aria-pressed': String(!!props.active)
  }), props.children, props.count ? h('span', { class: 'rl-chip-count' }, props.count) : null);
}

/* ---------- MessageStatus ---------- */
function MessageStatus(props) {
  var s = props.status || 'sent';
  var first = useRef(s); // рисуем галочки только при смене статуса, не при появлении на экране
  var size = props.size || 16;
  if (s === 'pending') {
    return h('span', { class: 'rl-status rl-status-clock', role: 'img', 'aria-label': 'в очереди' },
      h('svg', { width: size - 3, height: size - 3, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round' },
        h('path', { d: C(12, 12, 9) }), h('path', { class: 'rl-hand', d: 'M12 12V7' })));
  }
  if (s === 'failed') {
    return h('span', { class: 'rl-status rl-status-failed', role: 'img', 'aria-label': 'не отправлено' }, h(Icon, { name: 'alert', size: size - 2 }));
  }
  var two = s === 'delivered' || s === 'read';
  var label = s === 'read' ? 'прочитано' : two ? 'доставлено' : 'отправлено';
  return h('span', { key: s, class: cx('rl-status', s === 'read' && 'rl-status-read', s !== first.current && 'rl-status-anim'), role: 'img', 'aria-label': label },
    h('svg', { width: two ? size : size - 2, height: Math.round(size * 0.75), viewBox: two ? '0 0 18 12' : '0 0 16 12', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
      two
        ? [h('path', { key: 1, class: 'rl-draw', d: 'M1 6.5l3.2 3.2L11 2.5' }), h('path', { key: 2, class: 'rl-draw', d: 'M7.5 9.2l.5.5L15 2.5' })]
        : h('path', { class: 'rl-draw', d: 'M2.5 6.5l3.2 3.2L12.5 2.5' })));
}

/* ---------- TypingIndicator ---------- */
function TypingIndicator(props) {
  if (props.inline) return h('span', { class: 'rl-typing-inline', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'));
  return h('div', { class: 'rl-typing', role: 'status', 'aria-label': (props.who || 'Собеседник') + ' печатает' }, h('span'), h('span'), h('span'));
}

/* ---------- ChatRow ---------- */
function ChatRow(props) {
  var unread = props.unread || 0;
  var rest = omit(props, ['verified', 'logo', 'name', 'preview', 'time', 'unread', 'muted', 'status', 'active', 'typing', 'online', 'avatar', 'author', 'thumb', 'pinned', 'draft', 'mentioned', 'className', 'class']);
  // как в Telegram: «печатает» важнее черновика, черновик важнее сообщения;
  // строка сообщения — «Автор:», миниатюра 20 px (у видео — play), текст
  var thumb = props.thumb;
  var bottom = props.typing
    ? h('span', { class: 'rl-row-preview rl-row-typing' }, h(TypingIndicator, { inline: true }), 'печатает…')
    : props.draft
      ? h('span', { class: 'rl-row-preview' }, h('b', { class: 'rl-row-draft' }, 'Черновик: '), props.draft)
      : h('span', { class: 'rl-row-preview' },
        props.author ? h('span', { class: 'rl-row-author' }, props.author + ': ') : null,
        thumb ? h('span', { class: cx('rl-row-thumb', thumb.round && 'rl-row-thumb-round') }, h('img', { src: thumb.src, alt: '', draggable: false }),
          thumb.video ? h(Icon, { name: 'play', size: 12 }) : null) : null,
        props.preview);
  return h('button', Object.assign({ type: 'button' }, rest, { onPointerDown: chain(rest.onPointerDown, ripple),
    class: cx('rl-row', (props.className || props.class)), 'aria-current': props.active ? 'true' : undefined
  }),
    h(Avatar, { name: props.avatar === undefined ? props.name : props.avatar, tone: props.avatarTone, online: props.online, logo: props.logo, src: props.avatarSrc, thumb: props.avatarThumb, size: 54 }),   // как в Telegram: 54 в строке 72
    h('span', { class: 'rl-row-main' },
      h('span', { class: 'rl-row-top' },
        props.verified
          ? h('span', { class: 'rl-row-name rl-row-name-verified' }, h('span', { class: 'rl-row-name-text' }, props.name), h(Verified, { size: 16 }))
          : h('span', { class: 'rl-row-name' }, props.name),
        props.status ? h(MessageStatus, { status: props.status, size: 16 }) : null,
        h('span', { class: cx('rl-row-time', unread > 0 && !props.muted && 'rl-row-time-unread') }, props.time)),
      h('span', { class: 'rl-row-bottom' }, bottom,
        h('span', { class: 'rl-row-meta' },
          props.mentioned ? h('span', { class: 'rl-row-at', 'aria-label': 'Вас упомянули' }, '@') : null,
          props.muted ? h(Icon, { name: 'bellOff', size: 16, title: 'Без звука' }) : null,
          props.pinned ? h(Icon, { name: 'pinFilled', size: 16, title: 'Закреплён', class: 'rl-row-pin' }) : null,   // pin-filled
          unread > 0 ? h(Badge, { count: unread, muted: props.muted }) : null))));
}

/* ---------- ArchivedRow ---------- */
function ArchivedRow(props) {
  return h('button', { type: 'button', class: 'rl-row rl-row-archived', onPointerDown: ripple, onClick: props.onClick },
    h('span', { class: 'rl-row-archived-icon' }, h(Icon, { name: 'archiveFilled', size: 20 })),   // archive-filled
    h('span', { class: 'rl-row-name' }, props.label || 'Архив'),
    props.count ? h('span', { class: 'rl-row-time rl-row-time-unread' }, props.count) : null);
}

function ChatRowSkeleton() {
  return h('div', { class: 'rl-skel', 'aria-hidden': 'true' },
    h('i', { style: { width: 54, height: 54 } }),
    h('span', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 8 } },
      h('i', { style: { width: '55%', height: 12 } }),
      h('i', { style: { width: '80%', height: 10 } })));
}

/* строка сообщения: пузырь и (необязательно) кнопка сбоку — например, круглая «Переслать» при наведении */
function MsgLine(p) { return h('div', { class: p.class, onClick: p.onClick }, p.children, p.aside || null); }

/* ---------- ForwardTitle: «Переслано от» над содержимым пузыря ----------
   fwd = { name, tone, avatar?: пропсы Avatar (фото), onClick? }. Две строки цветом автора: стрелка + «Переслано от»,
   затем маленький аватар и имя (клик — открыть чат с автором). */
function ForwardTitle(props) {
  var f = props.fwd, tone = 'var(--peer-' + (f.tone != null ? f.tone : 5) + ')';
  return h(f.onClick ? 'button' : 'span', { type: f.onClick ? 'button' : undefined, class: cx('rl-fwd', f.onClick && 'rl-fwd-link', props.class), style: { '--fwd-tone': tone },
      onClick: f.onClick ? function (e) { e.stopPropagation(); f.onClick(); } : undefined, 'aria-label': 'Переслано от ' + f.name },
    h('span', { class: 'rl-fwd-label', 'aria-hidden': 'true' }, h(Icon, { name: 'forward', size: 14 }), 'Переслано от'),
    h('span', { class: 'rl-fwd-who', 'aria-hidden': 'true' }, h(Avatar, Object.assign({ name: f.name, tone: f.tone, size: 20 }, f.avatar || {})), h('b', null, f.name)));
}

/* ---------- WebPage: превью ссылки в пузыре (как в Telegram) ----------
   link = { url, siteName, title, description, photo: { src, w, h } }, tone — цвет полосы и названия сайта.
   Квадратная или маленькая картинка — миниатюрой справа (текст обтекает), остальные — во всю ширину под текстом. */
function WebPage(props) {
  var l = props.link, p = l.photo;
  var small = p && (p.w === p.h || p.w < 320);
  var host = '';
  try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch (e) { host = l.url; }
  return h('a', { class: cx('rl-webpage', small && 'rl-webpage-small'), href: l.url, target: '_blank', rel: 'noopener noreferrer', style: { '--lp-tone': props.tone || 'var(--brand-strong)' },
      onClick: function (e) { e.stopPropagation(); } },
    p && small ? h('img', { class: 'rl-webpage-thumb', src: p.src, alt: '', loading: 'lazy', decoding: 'async' }) : null,
    h('b', { class: 'rl-webpage-site' }, l.siteName || host),
    l.title ? h('span', { class: 'rl-webpage-title' }, l.title) : null,
    // описание — до ~170 знаков с многоточием, как в Telegram
    l.description ? h('span', { class: 'rl-webpage-desc' }, l.description.length > 170 ? l.description.slice(0, 168).trimEnd() + '…' : l.description) : null,
    p && !small ? h('img', { class: 'rl-webpage-photo', src: p.src, alt: '', loading: 'lazy', decoding: 'async', width: p.w, height: p.h, style: { aspectRatio: p.w + ' / ' + p.h } }) : null);
}

/* ---------- Bubble ---------- */
function Bubble(props) {
  var out = props.from === 'out';
  var failed = props.status === 'failed';
  var deleted = !!props.deleted;
  var line = h('div', {
      class: cx('rl-bubble', out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && 'rl-bubble-tail', failed && 'rl-bubble-failed',
        deleted && 'rl-bubble-deleted', props.reactions && props.reactions.length && 'rl-bubble-has-react',
        props.appear && (out ? 'rl-appear-out' : 'rl-appear-in'), props.flash && 'rl-bubble-flash', (props.className || props.class)),
      onContextMenu: props.onContextMenu, onDblClick: props.onDoubleClick
    },
      !deleted && !props.selectable ? h('button', { type: 'button', class: 'rl-bubble-menu', 'aria-label': 'Меню сообщения', onClick: props.onMenu }, h(Icon, { name: 'chevronDown', size: 18 })) : null,
      props.fwd && !deleted ? h(ForwardTitle, { fwd: props.fwd }) : null,
      props.author && !deleted && !props.fwd ? h(props.onAuthorClick ? 'button' : 'span', { type: props.onAuthorClick ? 'button' : undefined, class: cx('rl-bubble-author', props.onAuthorClick && 'rl-bubble-author-link'), onClick: props.onAuthorClick, style: { color: 'var(--peer-' + (props.authorTone != null ? props.authorTone : 5) + ')' } }, props.author) : null,
      props.reply && !deleted ? h(ReplyQuote, Object.assign({ inBubble: true }, props.reply)) : null,
      deleted
        ? h('span', { class: 'rl-bubble-text rl-bubble-deleted-text' }, h(Icon, { name: 'ban', size: 16 }), out ? 'Вы удалили это сообщение' : 'Сообщение удалено')
        : h('span', { class: 'rl-bubble-text' }, props.children),
      props.link && !deleted ? h(WebPage, { link: props.link, tone: props.linkTone }) : null,
      h('span', { class: cx('rl-bubble-spacer', props.edited && 'rl-bubble-spacer-edited'), 'aria-hidden': 'true' }),
      h('span', { class: 'rl-bubble-meta' },
        props.edited ? h('span', { class: 'rl-bubble-edited' }, 'изм.') : null,
        props.time,
        out && !deleted ? h(MessageStatus, { status: props.status || 'sent' }) : null),
      props.reactions && props.reactions.length ? h(ReactionChips, { items: props.reactions, out: out, onClick: props.onReactionClick }) : null);
  return h(MsgLine, {
    aside: props.aside,
    class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap', props.selectable && 'rl-msgline-select', props.selected && 'rl-msgline-selected'),
    onClick: props.selectable ? props.onSelect : undefined
  },
    props.selectable ? h('span', { class: 'rl-msg-check', role: 'checkbox', 'aria-checked': String(!!props.selected), 'aria-label': 'Выбрать сообщение' },
      h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, h('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }))) : null,
    line);
}

/* ---------- ReplyQuote: in a bubble or above the composer ---------- */
function ReplyQuote(props) {
  // tone — номер цвета собеседника (--peer-N) или 'accent' — свои сообщения: акцентный цвет темы, а не цвет из id
  var n = props.tone != null ? props.tone : 5;
  var accent = n === 'accent';
  var tone = accent ? 'var(--brand-text)' : 'var(--peer-' + n + ')';
  return h(props.onClick ? 'button' : 'div', { type: props.onClick ? 'button' : undefined, class: cx('rl-quote', props.inBubble && 'rl-quote-in'),
    style: { '--quote-tone': tone,
      '--quote-bg': accent ? 'color-mix(in srgb, var(--brand-text) 12%, transparent)' : 'var(--peer-' + n + '-bg)',
      '--quote-bg-active': accent ? 'color-mix(in srgb, var(--brand-text) 20%, transparent)' : 'var(--peer-' + n + '-bg-active)' }, onClick: props.onClick },
    // thumbSrc — настоящая картинка (превью ссылки): слева, как в Telegram
    // thumbBg — встроенная миниатюра подложкой (размытая, видна сразу), поверх проявляется настоящее изображение
    props.thumbSrc ? h('span', { class: 'rl-quote-thumb rl-quote-thumb-img', style: props.thumbBg ? { backgroundImage: 'url("' + String(props.thumbBg).replace(/"/g, '') + '")' } : undefined },
      h('img', { src: props.thumbSrc, alt: '', decoding: 'async', class: props.thumbBg ? 'rl-quote-loading' : undefined,
        onLoad: function (e) { e.currentTarget.classList.remove('rl-quote-loading'); } })) : null,
    h('span', { class: 'rl-quote-body' },
      h('b', { style: { color: 'var(--quote-tone)' } }, props.author),
      h('span', { class: 'rl-quote-text' }, props.icon ? h(Icon, { name: props.icon, size: 14 }) : null, props.text)),
    props.thumb !== undefined ? h('span', { class: 'rl-quote-thumb' }, h(MediaArt, { seed: props.thumb })) : null,
    props.onCancel ? h(IconButton, { icon: 'close', label: 'Отменить ответ', onClick: props.onCancel, size: 18 }) : null);
}

/* ---------- ReactionChips: under a bubble ---------- */
function ReactionChips(props) {
  return h('div', { class: cx('rl-reacts', props.out && 'rl-reacts-out') },
    props.items.map(function (r) {
      return h('button', { key: r.emoji + (r.count || 1) + (r.mine ? 'm' : ''), type: 'button', class: cx('rl-react', r.mine && 'rl-react-mine'), onClick: function (e) { e.stopPropagation(); if (props.onClick) props.onClick(r.emoji); }, 'aria-label': 'Реакция ' + r.emoji + (r.count > 1 ? ', ' + r.count : '') },
        h('span', { class: 'rl-react-emoji' }, r.emoji), r.count > 1 ? h('span', null, r.count) : null);
    }));
}

/* ---------- DateDivider ---------- */
function DateDivider(props) {
  // с onClick плашка — кнопка (как в Telegram: открывает «Перейти к дате»)
  return h('div', { class: 'rl-date', role: 'separator' }, props.onClick
    ? h('button', { type: 'button', class: 'rl-date-btn', onClick: props.onClick, 'aria-label': 'Перейти к дате, сейчас: ' + props.children }, props.children)
    : h('span', null, props.children));
}

/* ---------- Banner ---------- */
function Banner(props) {
  var tone = props.tone || 'brand';
  return h('div', { class: cx('rl-banner', tone !== 'brand' && 'rl-banner-' + tone, (props.className || props.class)), role: tone === 'brand' ? 'status' : 'alert' },
    props.icon ? h(Icon, { name: props.icon, size: 24 }) : null,
    h('div', { class: 'rl-banner-body' }, props.children, props.action ? ' ' : null,
      props.action ? h('button', { type: 'button', class: 'rl-banner-action', onClick: props.onAction }, props.action) : null),
    props.onClose ? h(IconButton, { icon: 'close', label: 'Закрыть', onClick: props.onClose, size: 20 }) : null);
}


/* ---------- NavRail ---------- */
function NavRail(props) {
  var items = props.items || [];
  var bottom = props.bottom || [];
  function item(it, i) {
    return it === '-' ? h('span', { key: 'sep' + i, class: 'rl-rail-sep' })
      : h(IconButton, { key: it.label, icon: it.icon, label: it.label, badge: it.badge, active: !!it.active, onClick: it.onClick });
  }
  return h('nav', { class: cx('rl-rail', (props.className || props.class)), 'aria-label': 'Разделы' },
    items.map(item), h('span', { class: 'rl-rail-spacer' }), bottom.map(item),
    props.me ? h(Avatar, { name: props.me, size: 32 }) : null);
}

/* ---------- Checkbox ---------- */
function Checkbox(props) {
  var id = props.id || 'rl-check';
  return h('label', { class: cx('rl-check', (props.className || props.class)), for: id },
    h('input', { id: id, type: 'checkbox', checked: props.checked, disabled: props.disabled, defaultChecked: props.defaultChecked, onChange: props.onChange }),
    h('span', { class: 'rl-check-box', 'aria-hidden': 'true' },
      h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, h('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }))),
    props.children);
}

/* ---------- Toast ---------- */
function Toast(props) {
  return h('div', { class: 'rl-toast', role: 'status' }, h('span', null, props.children),
    props.action ? h('button', { type: 'button', onClick: props.onAction }, props.action) : null);
}

/* ---------- Card & Steps ---------- */
function Card(props) {
  return h('section', { class: cx('rl-card', (props.className || props.class)), style: props.style }, props.children);
}
function Steps(props) {
  return h('ol', { class: 'rl-steps' }, (props.items || []).map(function (t, i) {
    return h('li', { key: i }, h('span', { class: 'rl-steps-num', 'aria-hidden': 'true' }, i + 1), h('span', null, t));
  }));
}

/* =====================================================================
   Media & voice
   ===================================================================== */

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
}
// Deterministic pseudo-waveform so the same message always draws the same bars.
function makeWave(seed, n) {
  var out = [], x = seed || 7;
  for (var i = 0; i < n; i++) { x = (x * 9301 + 49297) % 233280; out.push(0.15 + 0.85 * Math.abs(Math.sin(i / 2.3 + seed)) * (0.45 + 0.55 * x / 233280)); }
  return out;
}

/* ---------- MediaArt: theme-aware placeholder picture (no real photos in the system) ---------- */
var SCENES = [
  { sky: 'var(--author-1)', hill: 'var(--author-4)', sun: 'var(--brand)' },
  { sky: 'var(--author-3)', hill: 'var(--author-2)', sun: 'var(--on-warn-soft)' },
  { sky: 'var(--tick-read)', hill: 'var(--bubble-out)', sun: 'var(--bubble-in)' },
  { sky: 'var(--author-2)', hill: 'var(--author-1)', sun: 'var(--warn-soft)' }
];
function MediaArt(props) {
  var s = SCENES[(props.seed || 0) % SCENES.length];
  return h('svg', { class: cx('rl-art', props.blur && 'rl-art-blur', (props.className || props.class)), viewBox: '0 0 160 120', preserveAspectRatio: 'xMidYMid slice', role: 'img', 'aria-label': props.label || 'Изображение' },
    h('rect', { width: 160, height: 120, style: { fill: s.sky } }),
    h('circle', { cx: 118, cy: 34, r: 16, style: { fill: s.sun } }),
    h('path', { d: 'M0 92 L42 58 L74 84 L104 62 L160 98 V120 H0z', style: { fill: s.hill } }),
    h('path', { d: 'M0 120 L0 104 Q40 92 80 104 T160 102 V120z', style: { fill: 'var(--ink)', opacity: 0.18 } }));
}

/* ---------- ProgressRing: upload / download, determinate or spinning ---------- */
var RING_IDLE_ARC = 0.25;   // длина дуги без известного прогресса; известный прогресс стартует с неё же — без скачка
function ProgressRing(props) {
  var size = props.size || 48, r = (size - 6) / 2, c = 2 * Math.PI * r;
  var p = props.progress;
  var det = typeof p === 'number';
  return h('div', { class: cx('rl-ring', !det && 'rl-ring-spin', props.onMedia && 'rl-ring-onmedia'), style: { width: size, height: size }, role: 'progressbar', 'aria-valuenow': det ? Math.round(p * 100) : undefined, 'aria-label': props.label || 'Загрузка' },
    h('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, 'aria-hidden': 'true' },
      h('circle', { class: 'rl-ring-track', cx: size / 2, cy: size / 2, r: r }),
      h('circle', { class: 'rl-ring-arc', cx: size / 2, cy: size / 2, r: r, style: { strokeDasharray: c, strokeDashoffset: c * (1 - (det ? Math.max(RING_IDLE_ARC, Math.min(1, p)) : RING_IDLE_ARC)) } })),
    props.onCancel ? h('button', { type: 'button', class: 'rl-ring-cancel', 'aria-label': 'Отменить', onClick: props.onCancel }, h(Icon, { name: 'close', size: 18 })) : null);
}

/* ---------- VoiceMessage ---------- */
var SPEEDS = [1, 1.5, 2];
function Waveform(props) {
  var bars = props.bars;
  return h('span', { class: cx('rl-wave', (props.className || props.class)), 'aria-hidden': 'true' },
    bars.map(function (v, i) { return h('i', { key: i, style: { height: Math.max(3, Math.round(v * 22)) } }); }));
}
function VoiceMessage(props) {
  var out = props.from === 'out';
  var duration = props.duration || 12;
  var bars = props.waveform || makeWave(props.seed || duration, 42);
  var st = useState({ playing: false, played: !!props.played, speed: 0 });
  var s = st[0];
  var progRef = useRef(0), playedLayer = useRef(null), thumb = useRef(null), clock = useRef(null), raf = useRef(0);
  var WIDTH = bars.length * 5 - 2;

  // Playback position is written straight to the DOM once per frame (no re-render per frame):
  // the mutate-only pattern the README describes for fasterdom.
  function paint() {
    var p = progRef.current;
    if (playedLayer.current) playedLayer.current.style.clipPath = 'inset(0 ' + ((1 - p) * 100).toFixed(2) + '% 0 0)';
    if (thumb.current) thumb.current.style.transform = 'translateX(' + (p * WIDTH).toFixed(1) + 'px)';
    if (clock.current) clock.current.textContent = fmtTime(p > 0 ? p * duration : duration);
  }
  useEffect(function () {
    if (!s.playing) return;
    var last = performance.now();
    function tick(now) {
      progRef.current = Math.min(1, progRef.current + (now - last) / 1000 * SPEEDS[s.speed] / duration);
      last = now;
      paint();
      if (progRef.current >= 1) { progRef.current = 0; paint(); st[1]({ playing: false, played: true, speed: s.speed }); return; }
      raf.current = requestAnimationFrame(tick);
    }
    raf.current = requestAnimationFrame(tick);
    return function () { cancelAnimationFrame(raf.current); };
  }, [s.playing, s.speed]);
  useEffect(paint, []);

  function toggle() { st[1]({ playing: !s.playing, played: true, speed: s.speed }); }
  function seek(e) {
    var el = e.currentTarget, x = e.clientX;
    requestMeasure(function () {
      var rect = el.getBoundingClientRect();
      progRef.current = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
      requestMutation(paint);
    });
  }
  function cycleSpeed() { st[1]({ playing: s.playing, played: s.played, speed: (s.speed + 1) % SPEEDS.length }); }

  var thumbColor = !s.played ? (out ? 'var(--voice-new-out)' : 'var(--voice-new)') : 'var(--tick-read)';
  return h(MsgLine, { aside: props.aside, class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-bubble rl-voice', out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && 'rl-bubble-tail', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in')) },
      h('div', { class: 'rl-voice-row' },
        h('button', { type: 'button', class: 'rl-voice-play', onPointerDown: ripple, 'aria-label': s.playing ? 'Пауза' : 'Воспроизвести', onClick: toggle },
          h(Icon, { name: 'play', size: 26, class: s.playing ? 'rl-swap-off' : '' }),
          h(Icon, { name: 'pause', size: 26, class: s.playing ? '' : 'rl-swap-off' })),
        h('div', { class: 'rl-voice-track', onClick: seek, role: 'slider', 'aria-label': 'Позиция', 'aria-valuemin': 0, 'aria-valuemax': duration, tabIndex: 0 },
          h(Waveform, { bars: bars, class: 'rl-wave-base' }),
          h('span', { ref: playedLayer, class: 'rl-wave-played' }, h(Waveform, { bars: bars })),
          h('span', { ref: thumb, class: 'rl-voice-thumb', style: { background: thumbColor } })),
        s.playing || s.speed
          ? h('button', { type: 'button', class: 'rl-voice-speed', onClick: cycleSpeed, 'aria-label': 'Скорость' }, SPEEDS[s.speed] + '×')
          : h('span', { class: 'rl-voice-avatar' }, h(Avatar, { name: props.name, size: 48 }),
            h('span', { class: 'rl-voice-mic', style: { color: !s.played && !out ? 'var(--voice-new)' : 'var(--tick-read)' } }, h(Icon, { name: 'mic', size: 16, strokeWidth: 2.4 })))),
      h('div', { class: 'rl-voice-foot' },
        h('span', { ref: clock, class: 'rl-voice-time' }, fmtTime(duration)),
        h('span', { class: 'rl-bubble-meta rl-voice-meta' }, props.time, out ? h(MessageStatus, { status: props.status || 'read' }) : null))));
}

/* ---------- VoiceRecorder: replaces the Composer while recording ---------- */
function VoiceRecorder(props) {
  var st = useState({ paused: false, elapsed: 0, levels: [] });
  var s = st[0];
  useEffect(function () {
    if (s.paused) return;
    var t = setInterval(function () {
      st[1](function (p) {
        var lv = props.getLevel ? props.getLevel() : 0.2 + Math.random() * 0.8;
        var levels = p.levels.concat([lv]);
        if (levels.length > 60) levels = levels.slice(-60);
        return { paused: p.paused, elapsed: p.elapsed + 0.1, levels: levels };
      });
    }, 100);
    return function () { clearInterval(t); };
  }, [s.paused]);
  return h('div', { class: 'rl-composer rl-recorder', role: 'group', 'aria-label': 'Запись голосового' },
    h(IconButton, { icon: 'trash', label: 'Удалить запись', onClick: props.onCancel }),
    h('div', { class: 'rl-rec-body' },
      s.paused
        ? h('button', { type: 'button', class: 'rl-rec-preview', 'aria-label': 'Прослушать черновик' }, h(Icon, { name: 'play', size: 18 }))
        : h('span', { class: 'rl-rec-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'rl-rec-time', 'aria-live': 'off' }, fmtTime(s.elapsed)),
      h('span', { class: cx('rl-rec-wave', s.paused && 'rl-rec-wave-paused') }, h(Waveform, { bars: s.levels }))),
    h(IconButton, { icon: s.paused ? 'mic' : 'pause', label: s.paused ? 'Продолжить запись' : 'Пауза', class: s.paused ? 'rl-rec-resume' : '', onClick: function () { st[1]({ paused: !s.paused, elapsed: s.elapsed, levels: s.levels }); } }),
    h('button', { type: 'button', class: cx('rl-composer-send', !s.paused && 'rl-rec-pulse'), 'aria-label': 'Отправить голосовое', onClick: function () { if (props.onSend) props.onSend({ duration: Math.round(s.elapsed), waveform: s.levels.slice(-42) }); } },
      h(Icon, { name: 'sendFilled', size: 22 })));
}

/* ---------- MediaBubble: photo, video, album ---------- */
function MediaOverlay(props) {
  // state: 'ready' | 'remote' (not downloaded) | 'loading' | 'uploading'
  if (props.state === 'remote') return h('button', { type: 'button', class: 'rl-media-dl', onClick: props.onDownload }, h(Icon, { name: 'download', size: 18 }), props.size || 'Скачать');
  if (props.state === 'loading' || props.state === 'uploading') return h('div', { class: 'rl-media-center' }, h(ProgressRing, { progress: props.progress, onMedia: true, onCancel: props.onCancel, label: props.state === 'uploading' ? 'Отправка' : 'Загрузка' }));
  if (props.kind === 'video' && !props.playing) return h('div', { class: 'rl-media-center' }, h('span', { class: 'rl-media-play' }, h(Icon, { name: 'play', size: 26 })));
  return null;
}

/* ---------- InlineVideo: видео в ленте, как в Telegram — без звука, по кругу, играет только пока на экране ----------
   Одно общее IntersectionObserver: видно больше половины — play(), ушло — pause() (десятки роликов в истории не жрут CPU).
   До первого кадра — размытая встроенная миниатюра; плашка слева сверху — сколько осталось. autoplay=false — стоит
   на первом кадре (preload=metadata), включится в просмотрщике. preview — играет короткий немой ролик сервера (первые
   секунды, 360p, до 1 МБ) вместо оригинала: плашка показывает длительность всего видео, а не ролика. */
var videoIO = null, videoCbs = typeof WeakMap === 'function' ? new WeakMap() : null;
function videoObserve(el, cb) {
  if (typeof IntersectionObserver === 'undefined') { cb(true); return function () {}; }
  if (!videoIO) videoIO = new IntersectionObserver(function (es) {
    es.forEach(function (e) { var f = videoCbs.get(e.target); if (f) f(e.isIntersecting && e.intersectionRatio >= 0.5); });
  }, { threshold: [0, 0.5] });
  videoCbs.set(el, cb); videoIO.observe(el);
  return function () { videoCbs.delete(el); videoIO.unobserve(el); };
}
/* Истёкшая подписанная ссылка посреди просмотра (как в Telegram — незаметно): /files/<id> отдаёт 302 на ссылку
   хранилища, плеер ходит за кусками уже по ней, и через срок ссылки следующий кусок получает 403 → MEDIA_ERR_NETWORK
   (или SRC_NOT_SUPPORTED, если тело ошибки приняли за видео). Тогда: снимок текущего кадра поверх, тот же src заново
   (браузер снова пройдёт через /files/<id> и получит свежую ссылку), то же место, игра/пауза как было; снимок
   убираем, когда встал нужный кадр. Не больше 3 раз в минуту — иначе это не срок ссылки, а настоящая ошибка. */
function useVideoRecovery(ref, src) {
  useEffect(function () {
    var v = ref.current;
    if (!v || !src) return undefined;
    var tries = 0, first = 0, cover = null, pending = null, waitSeek = false, stall = 0, loadedAt = Date.now();
    // Chrome после перемотки идёт за куском по старой (истёкшей) ссылке; 403 с XML блокирует ORB, и плеер молча
    // повторяет запрос ~30 с, не давая error. Поэтому и «ждёт данных дольше 2 с» на ссылке старше 15 с — тоже сюда.
    function onWaiting() {
      clearTimeout(stall);
      if (pending || v.paused || Date.now() - loadedAt < 15000) return;
      stall = setTimeout(function () { if (!v.paused && v.readyState < 3 && !pending) recover(); }, 2000);
    }
    function onProgressing() { clearTimeout(stall); }
    function uncover() {
      if (!cover) return;
      var c = cover; cover = null;
      c.style.opacity = '0';
      setTimeout(function () { c.remove(); }, 180);
    }
    function onError() {
      var err = v.error;
      if (err && (err.code === 2 || err.code === 4)) recover();
    }
    function recover() {
      clearTimeout(stall);
      var now = Date.now();
      if (now - first > 60000) { first = now; tries = 0; }
      if (++tries > 3) return;
      var t = pending ? pending.t : v.currentTime, play = pending ? pending.play : !v.paused;
      if (!cover && v.videoWidth && v.parentNode) {
        try {
          var c = document.createElement('canvas');
          c.width = v.videoWidth; c.height = v.videoHeight;
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          c.className = v.className + ' rl-video-cover';
          c.setAttribute('aria-hidden', 'true');
          v.parentNode.insertBefore(c, v.nextSibling);
          cover = c;
        } catch (e) { /* кадр не снять — перезапуск будет виден на миг */ }
      }
      pending = { t: t, play: play };
      loadedAt = now;
      // тот же адрес: присваивание src заново запускает загрузку с начала (у Preact src тот же — он не вмешается)
      v.src = src;
      v.load();
    }
    function onMeta() {
      var p = pending;
      if (!p) return;
      pending = null;
      waitSeek = p.t > 0;
      if (waitSeek) { try { v.currentTime = p.t; } catch (e) { waitSeek = false; } }
      if (p.play) { var r = v.play(); if (r && r.catch) r.catch(function () {}); }
    }
    function onData() { if (!pending && !waitSeek) uncover(); }
    function onSeeked() { if (!pending) { waitSeek = false; uncover(); } }
    v.addEventListener('error', onError);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('loadeddata', onData);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onProgressing);
    v.addEventListener('pause', onProgressing);
    v.addEventListener('canplay', onProgressing);
    return function () {
      clearTimeout(stall);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onProgressing);
      v.removeEventListener('pause', onProgressing);
      v.removeEventListener('canplay', onProgressing);
      v.removeEventListener('error', onError);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('loadeddata', onData);
      v.removeEventListener('seeked', onSeeked);
      if (cover) cover.remove();
    };
  }, [src]);
}
function InlineVideo(props) {
  var ref = useRef(null), loaded = useState(false), left = useState(props.duration || 0);
  useVideoRecovery(ref, props.src);
  useEffect(function () {
    var v = ref.current;
    if (!v || !props.autoplay) return undefined;
    return videoObserve(v, function (on) { if (on) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } else v.pause(); });
  }, [props.src, props.autoplay]);
  return h('span', { class: cx('rl-lazy', loaded[0] && 'rl-lazy-loaded') },
    props.thumb ? h('img', { class: 'rl-lazy-thumb', src: props.thumb, alt: '', 'aria-hidden': 'true' }) : null,
    h('video', { ref: ref, class: 'rl-lazy-full rl-inline-video', src: props.src, muted: true, loop: true, playsInline: true, disablePictureInPicture: true,
      preload: props.autoplay ? 'auto' : 'metadata', 'aria-hidden': 'true', tabIndex: -1,
      onLoadedData: function () { loaded[1](true); },
      onTimeUpdate: props.preview ? undefined : function (e) { var v = e.currentTarget, d = v.duration || props.duration || 0, r = Math.max(0, Math.ceil(d - v.currentTime)); if (r !== left[0]) left[1](r); } }),
    props.chip !== false ? h('span', { class: 'rl-media-chip rl-media-chip-dur rl-media-chip-top' }, fmtTime(props.autoplay && !props.preview ? left[0] : props.duration || 0), h(Icon, { name: 'volumeOff', size: 12 })) : null);
}

/* Спойлер на фото/видео (как в Telegram): сильно размытая миниатюра и мерцающие точки, пока не нажмут.
   Раскрытое помним до перезагрузки вкладки — прокрутка туда-обратно не прячет его снова. */
var spoilersOpen = new Set();
function MediaSpoiler(props) {
  return h('span', { class: 'rl-media-spoiler', role: 'button', tabIndex: 0, 'aria-label': 'Показать скрытое медиа',
    onClick: function (e) { e.stopPropagation(); props.onReveal(); },
    onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); props.onReveal(); } } },
    props.thumb ? h('img', { class: 'rl-media-spoiler-img', src: props.thumb, alt: '', 'aria-hidden': 'true' }) : null,
    h('span', { class: 'rl-media-spoiler-dots', 'aria-hidden': 'true' }));
}
/* ---------- LazyImage: blurred thumb at once, the full image only when it is within 500px of the viewport ----------
   One shared IntersectionObserver per scroll root. The box is sized by the parent (aspect ratio known up front),
   so loading never shifts the feed. Внутри своей прокрутки (правая панель) корень наблюдателя — она сама:
   с корнем-окном запас 500px обрезается краем панели и картинка грузится, только когда уже видна.
   Корень задаёт LazyRoot.Provider (элемент прокрутки) или третий аргумент lazyObserve. */
var LazyRoot = createContext(/** @type {Element | null} */ (null));
/* Наблюдатель на корень живёт, пока за ним есть элементы: счётчик; последний ушёл (загрузился или размонтирован) —
   disconnect и запись корня удаляется (закрытая панель не держит наблюдатель и своё отсоединённое дерево). */
var lazyIOs = new Map(), lazyCbs = typeof WeakMap === 'function' ? new WeakMap() : null;
function lazyObserve(el, cb, root) {
  root = root || null;
  var ent = lazyIOs.get(root);
  if (!ent) {
    ent = { io: null, n: 0 };
    ent.io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (!e.isIntersecting) return; var x = lazyCbs.get(e.target); if (x) { x.release(); x.f(); } });
    }, { root: root, rootMargin: '500px 0px' });
    lazyIOs.set(root, ent);
  }
  var done = false;
  function release() {
    if (done) return;
    done = true;
    lazyCbs.delete(el); ent.io.unobserve(el);
    if (--ent.n === 0) { ent.io.disconnect(); if (lazyIOs.get(root) === ent) lazyIOs.delete(root); }
  }
  lazyCbs.set(el, { f: cb, release: release });
  ent.n++; ent.io.observe(el);
  return release;
}
/** Сколько корней сейчас наблюдается (для тестов: утечки наблюдателей). */
function lazyRoots() { return lazyIOs.size; }
function LazyImage(props) {
  var ref = useRef(null), vis = useState(!!props.eager), loaded = useState(false);
  var root = useContext(LazyRoot);
  useEffect(function () { if (vis[0] || !ref.current) return; return lazyObserve(ref.current, function () { vis[1](true); }, root); }, [root]);
  return h('span', { ref: ref, class: cx('rl-lazy', loaded[0] && 'rl-lazy-loaded') },
    props.thumb ? h('img', { class: 'rl-lazy-thumb', src: props.thumb, alt: '', 'aria-hidden': 'true' }) : null,
    vis[0] && props.src ? h('img', { class: 'rl-lazy-full', src: props.src, alt: props.alt || '', decoding: 'async', draggable: false, onLoad: function () { loaded[1](true); if (props.onLoad) props.onLoad(); } }) : null);
}

/* ---------- MediaPolicy: autoload of incoming media, set by the app per chat ----------
   value: { photo: boolean, video: boolean } — false keeps the full image behind «Скачать» (thumb only).
   No provider = load everything. Own (out) media is always shown: it is already local. */
/** @type {import('preact').Context<{ photo?: boolean, video?: boolean } | null>} */
var MediaPolicy = createContext(/** @type {{ photo?: boolean, video?: boolean } | null} */ (null));
var mediaAsked = new Set();   // src the user asked to download in this tab: scrolling back does not hide it again
function mediaHeld(policy, items, out) {
  if (!policy || out) return false;
  return items.some(function (it) {
    if (!it.src || mediaAsked.has(it.src)) return false;
    return it.kind === 'video' ? policy.video === false : policy.photo === false;
  });
}

/* Цвет хвостика у картинки без рамки — как в Telegram: цвет самого углового пикселя картинки
   (своё — правый нижний, чужое — левый нижний). Сначала из полного изображения (если браузер разрешает читать
   его пиксели), иначе — из встроенной миниатюры в её родном размере. Результат кэшируем по адресу. */
var tailColors = new Map();
function cornerPixel(src, out) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.decoding = 'async';
    img.onload = function () {
      try {
        var w = img.naturalWidth, hgt = img.naturalHeight, k = Math.min(1, 256 / Math.max(w, hgt)); // большое — уменьшаем до 256px: угол тот же
        var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(hgt * k));
        var x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, c.width, c.height);
        var d = x.getImageData(out ? c.width - 1 : 0, c.height - 1, 1, 1).data;
        resolve('rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')');
      } catch (e) { reject(e); }
    };
    img.onerror = reject;
    img.src = src;
  });
}
function useTailColor(full, thumb, out) {
  var key = full || thumb ? (out ? 'r:' : 'l:') + (full || thumb) : null;
  var st = useState(key ? tailColors.get(key) || null : null);
  useEffect(function () {
    if (!key) return undefined;
    if (tailColors.has(key)) { st[1](tailColors.get(key)); return undefined; }
    var alive = true;
    // полное — только своё (тот же домен, blob:, data:): чужое с CORS скачалось бы второй раз
    var own = full && (/^(data|blob):/.test(full) || new URL(full, location.href).origin === location.origin);
    var p = own ? cornerPixel(full, out) : Promise.reject();
    p.catch(function () { return thumb ? cornerPixel(thumb, out) : Promise.reject(); })
      .then(function (color) { tailColors.set(key, color); if (alive) st[1](color); })
      .catch(function () { /* нечем посчитать — останется нейтральный */ });
    return function () { alive = false; };
  }, [key]);
  return key ? st[0] || '#ccc' : null;
}

/* Мозаика альбома (своя раскладка, по смыслу — как в Telegram): фото по порядку раскладываются в 1–4 строки,
   в строке высота общая, ширины — по пропорциям. Из всех разбиений берём то, где высота альбома ближе к целевой,
   а строки не слишком низкие. Возвращает клетки в долях ширины W: { x, y, w, h } и общую высоту. */
export function albumLayout(ratios, W, gap) {
  var n = ratios.length, best = null, target = W * (n === 2 ? 0.75 : 1.05), minRow = W * 0.24;
  W = W || 330; gap = gap == null ? 2 : gap;
  function rowsOf(cuts) { var rows = [], s = 0; cuts.concat([n]).forEach(function (c) { rows.push(ratios.slice(s, c)); s = c; }); return rows; }
  function score(rows) {
    var H = 0, bad = 0;
    rows.forEach(function (r) {
      var h = (W - gap * (r.length - 1)) / r.reduce(function (a, b) { return a + b; }, 0);
      if (h < minRow) bad += (minRow - h) * 3;
      if (h > W * 1.1) bad += h - W * 1.1;
      H += h;
    });
    H += gap * (rows.length - 1);
    return Math.abs(H - target) + bad;
  }
  // все разрезы на ≤ 4 строки (n ≤ 10 — перебор небольшой)
  (function walk(from, cuts) {
    if (cuts.length <= 3) {
      var rows = rowsOf(cuts), sc = score(rows);
      if (!best || sc < best.sc) best = { sc: sc, rows: rows };
    }
    if (cuts.length === 3) return;
    for (var c = from + 1; c < n; c++) walk(c, cuts.concat([c]));
  })(0, []);
  var cells = [], y = 0;
  best.rows.forEach(function (r) {
    var h = (W - gap * (r.length - 1)) / r.reduce(function (a, b) { return a + b; }, 0), x = 0;
    r.forEach(function (ar) { var w = h * ar; cells.push({ x: x / W, y: y, w: w / W, h: h }); x += w + gap; });
    y += h + gap;
  });
  var H = y - gap;
  cells.forEach(function (c) { c.y = c.y / H; c.h = c.h / H; });
  return { cells: cells, ratio: W / H };
}

function MediaBubble(props) {
  var out = props.from === 'out';
  var items = props.items || [{ seed: props.seed || 0, kind: props.kind || 'image', duration: props.duration }];
  var album = items.length > 1;
  var policy = useContext(MediaPolicy), asked = useState(0);
  var held = (props.state || 'ready') === 'ready' && mediaHeld(policy, items, out);
  var state = held ? 'remote' : props.state || 'ready';
  if (held) {
    items = items.map(function (it) { return Object.assign({}, it, { src: undefined }); });
    props = Object.assign({}, props, { onDownload: function () {
      (props.items || []).forEach(function (it) { if (it.src) mediaAsked.add(it.src); });
      asked[1](asked[0] + 1);
    } });
  }
  var extra = items.length - 4;
  // у всех фото альбома известны размеры — мозаикой, как в Telegram (иначе — старая сетка 2×2)
  var mosaic = album && items.every(function (it) { return it.w && it.h; }) ? albumLayout(items.map(function (it) { return it.w / it.h; }), 330, 2) : null;
  if (mosaic) extra = 0;
  var mediaOnly = !props.caption && !props.author && !props.fwd && !props.reply;
  // у одиночного фото без рамки хвостик красится в цвет нижнего угла картинки (как в Telegram); у альбома — последней ячейки
  var cornerOf = items[album ? Math.min(items.length, 4) - 1 : 0] || {};
  var tailColor = useTailColor(mediaOnly && props.tail ? cornerOf.src : null, mediaOnly && props.tail ? cornerOf.thumb : null, out);
  var autoplay = !policy || policy.autoplayVideo !== false;
  var reveal = useState(0);
  var busy = state === 'loading' || state === 'uploading';
  function cell(it, i) {
    var last = album && i === 3 && extra > 0;
    var hidden = it.spoiler && !spoilersOpen.has(it.skey || it.src || it.thumb || i);
    var vid = it.kind === 'video' && it.src && !hidden;
    // режим выбора (it.sel задан): у каждой ячейки альбома свой кружок справа сверху, отмеченное фото чуть уменьшается
    return h('button', { key: i, type: 'button', class: cx('rl-media-cell', it.sel !== undefined && 'rl-media-cell-sel', it.sel && 'rl-media-cell-on'), 'data-mkey': it.mkey, onClick: function () { if (props.onOpen && state === 'ready') props.onOpen(i); }, 'aria-label': it.kind === 'video' ? 'Открыть видео' : 'Открыть фото' },
      hidden ? h(MediaSpoiler, { thumb: it.thumb, onReveal: function () { spoilersOpen.add(it.skey || it.src || it.thumb || i); reveal[1](reveal[0] + 1); } })
        : vid ? h(InlineVideo, { src: it.inline || it.src, preview: !!it.inline, thumb: it.thumb, duration: it.duration, autoplay: autoplay && !(album && i > 3), chip: !busy })
        : it.src || it.thumb ? h(LazyImage, { src: it.kind === 'video' ? undefined : it.src, thumb: it.thumb, alt: it.alt }) : h(MediaArt, { seed: it.seed, blur: state === 'remote' }),
      it.kind === 'video' && !vid && !hidden && !busy ? h('span', { class: 'rl-media-chip rl-media-chip-dur rl-media-chip-top' }, h(Icon, { name: 'video', size: 14 }), fmtTime(it.duration || 0)) : null,
      // загрузка: процент слева сверху (как в Telegram), кольцо с × — по центру
      !album && busy && typeof props.progress === 'number' ? h('span', { class: 'rl-media-chip rl-media-chip-dur rl-media-chip-top' }, Math.round(Math.max(0, Math.min(1, props.progress)) * 100) + '%') : null,
      last ? h('span', { class: 'rl-media-more' }, '+' + (extra + 1)) : null,
      it.sel !== undefined ? h('span', { class: 'rl-media-check', 'aria-hidden': 'true' }, h(Icon, { name: 'check', size: 12, strokeWidth: 3 })) : null,
      !album && !hidden ? h(MediaOverlay, { state: state, kind: it.kind, playing: vid && autoplay, progress: props.progress, size: props.size, onDownload: props.onDownload, onCancel: props.onCancel }) : null);
  }
  return h(MsgLine, { aside: props.aside, class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    // без подписи и автора — как в Telegram: картинка без рамки пузыря (без фона и отступов), углы — от пузыря;
    // хвостик остаётся, а его цвет берётся из нижнего угла картинки (см. useTailColor)
    h('div', { class: cx('rl-bubble rl-media', mediaOnly && 'rl-media-only', out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && 'rl-bubble-tail', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in')),
      style: tailColor ? { '--tail-bg': tailColor } : undefined },
      props.fwd ? h(ForwardTitle, { fwd: props.fwd, class: 'rl-media-author' }) : null,
      props.author && !props.fwd ? h('span', { class: 'rl-bubble-author rl-media-author', style: { color: 'var(--peer-' + (props.authorTone != null ? props.authorTone : 5) + ')' } }, props.author) : null,
      props.reply ? h('div', { class: 'rl-media-reply' }, h(ReplyQuote, Object.assign({ inBubble: true }, props.reply))) : null,
      h('div', { class: cx('rl-media-frame', album && (mosaic ? 'rl-media-mosaic' : 'rl-media-album')), style: mosaic ? { aspectRatio: String(mosaic.ratio) } : album ? null : { aspectRatio: props.ratio || '4 / 3' } },
        mosaic ? items.map(function (it, i) {
          var c = mosaic.cells[i];
          return h('div', { key: i, class: 'rl-media-tile', style: { left: c.x * 100 + '%', top: c.y * 100 + '%', width: c.w * 100 + '%', height: c.h * 100 + '%' } }, cell(it, i));
        }) : (album ? items.slice(0, 4) : items).map(cell),
        album && state !== 'ready' ? h(MediaOverlay, { state: state, progress: props.progress, size: props.size, onDownload: props.onDownload, onCancel: props.onCancel }) : null,
        !props.caption ? h('span', { class: 'rl-media-chip rl-media-chip-meta' }, props.time, out ? h(MessageStatus, { status: props.status || 'read' }) : null) : null),
      props.caption ? h('div', { class: 'rl-media-caption' }, props.caption, h('span', { class: 'rl-bubble-spacer', 'aria-hidden': 'true' }),
        h('span', { class: 'rl-bubble-meta' }, props.time, out ? h(MessageStatus, { status: props.status || 'read' }) : null)) : null));
}

/* ---------- FileBubble: documents ---------- */
/** Цвет иконки файла по расширению (как в Telegram): pdf — красный, архивы и презентации — оранжевый, таблицы и apk — зелёный. */
function fileKind(ext) {
  ext = String(ext || '').toLowerCase();
  if (ext === 'pdf') return 'red';
  if (/^(zip|rar|7z|tar|gz|ppt|pptx|key)$/.test(ext)) return 'orange';
  if (/^(xls|xlsx|csv|numbers|apk)$/.test(ext)) return 'green';
  return 'blue';
}
function FileBubble(props) {
  var out = props.from === 'out';
  var ext = (props.ext || 'pdf').toUpperCase();
  // кольцо — только если загрузка дольше 150 мс (из кэша — сразу готово, без мигания), и не короче 600 мс;
  // пока кольца нет — прежний вид квадрата. Смена вида — плавная (rl-file-face, ключ по виду).
  var ring = useMinVisible(props.state === 'loading', { delay: 150, min: 600 });
  var last = useRef(props.state === 'loading' ? 'ready' : props.state);
  if (props.state !== 'loading') last.current = props.state;
  var face = ring ? 'loading' : props.state === 'loading' ? last.current : props.state;
  var label = ext.length > 4 ? ext.slice(0, 4) : ext;
  return h(MsgLine, { aside: props.aside, class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-bubble rl-file', out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && 'rl-bubble-tail') },
      props.fwd ? h(ForwardTitle, { fwd: props.fwd }) : null,
      props.reply ? h(ReplyQuote, Object.assign({ inBubble: true }, props.reply)) : null,
      // как в Telegram: цветной квадрат с загнутым уголком и расширением; скачивание и загрузка — внутри квадрата
      h('div', { class: 'rl-file-card' },
        face === 'remote'
          ? h('button', { type: 'button', class: 'rl-file-icon rl-file-icon-btn', 'data-ext': ext, 'data-kind': fileKind(ext), 'aria-label': 'Скачать файл', onClick: props.state === 'loading' ? undefined : props.onDownload },
              h('span', { key: 'dl', class: 'rl-file-face' }, h(Icon, { name: 'download', size: 24 })))
          // не отправлено (отказ): вместо застывшего кольца — «повторить», как в Telegram; удалить — из меню сообщения
          : face === 'failed'
          ? h('button', { type: 'button', class: 'rl-file-icon rl-file-icon-btn rl-file-icon-failed', 'data-ext': ext, 'data-kind': fileKind(ext), 'aria-label': 'Повторить отправку', onClick: props.onRetry }, h(Icon, { name: 'refresh', size: 24 }))
          : face === 'loading'
          ? h('span', { class: 'rl-file-icon', 'data-ext': ext, 'data-kind': fileKind(ext) },
              h('span', { key: 'ring', class: 'rl-file-face' }, h(ProgressRing, { size: 40, progress: props.state === 'loading' ? props.progress : 1, onMedia: true, onCancel: props.state === 'loading' ? props.onCancel : undefined })))
          // скачан (лежит на устройстве): квадрат с расширением — нажатие открывает сразу, без сети
          : props.onOpen
          ? h('button', { type: 'button', class: 'rl-file-icon rl-file-icon-btn', 'data-ext': ext, 'data-kind': fileKind(ext), 'aria-label': 'Открыть файл', onClick: props.onOpen },
              h('b', { key: 'ext', class: 'rl-file-face' }, label))
          : h('span', { class: 'rl-file-icon', 'data-ext': ext, 'data-kind': fileKind(ext) }, h('b', { key: 'ext', class: 'rl-file-face' }, label)),
        h('span', { class: 'rl-file-text' }, h('span', { class: 'rl-file-name' }, props.name), h('span', { class: 'rl-file-sub' }, props.meta))),
      h('div', { class: 'rl-file-foot' }, h('span', { class: 'rl-bubble-meta' }, props.time, out ? h(MessageStatus, { status: props.status || 'read' }) : null))));
}

/* ---------- MediaThumb: gallery tile (info panel, media tab) ---------- */
function MediaThumb(props) {
  return h('button', { type: 'button', onPointerDown: ripple, class: cx('rl-thumb', props.selected && 'rl-thumb-selected', (props.className || props.class)), style: { width: props.size, height: props.size }, onClick: props.onClick, 'aria-label': props.kind === 'video' ? 'Видео' : 'Фото', 'aria-current': props.selected ? 'true' : undefined },
    props.state === 'remote'
      ? h('span', { class: 'rl-thumb-remote' }, h('span', null, h(Icon, { name: 'download', size: 22 })))
      : h(MediaArt, { seed: props.seed }),
    props.kind === 'video' && props.duration ? h('span', { class: 'rl-media-chip rl-media-chip-dur' }, h(Icon, { name: 'video', size: 14 }), fmtTime(props.duration)) : null);
}

/* ---------- MediaViewer: full-screen gallery ---------- */
/* MediaViewer. Открытие — как в Telegram: фото «вылетает» из миниатюры в ленте и ложится по центру,
   фон и панели проявляются; закрытие — обратно в ту же миниатюру (если она на экране), иначе тает.
   Миниатюра на время просмотра скрыта — фото словно подняли с места. FLIP: коробка сразу стоит
   в итоговом прямоугольнике, а transform временно возвращает её на место миниатюры. */
var VIEWER_MS = 220;
var VIEWER_TOP = 60, VIEWER_BOTTOM = 56, VIEWER_SIDE = 72;
function viewerRect(w, hgt) {
  var aw = Math.max(1, innerWidth - VIEWER_SIDE * 2), ah = Math.max(1, innerHeight - VIEWER_TOP - VIEWER_BOTTOM);
  var k = Math.min(aw / w, ah / hgt, 1);
  if (k < 1 || w * k < 320) k = Math.min(aw / w, ah / hgt, Math.max(1, 320 / w));   // мелкие не крошим, крупные вписываем
  var W = Math.round(w * k), H = Math.round(hgt * k);
  return { left: Math.round((innerWidth - W) / 2), top: Math.round(VIEWER_TOP + (ah - H) / 2), width: W, height: H };
}
/* Полёт коробки просмотра в плитку (f) и обратно: масштаб равномерный — фото не сплющивается, — коробка
   накрывает плитку целиком (как object-fit: cover), лишнее срезает clip-path по краям плитки со скруглением r.
   area — видимая часть ленты: что под шапкой/полем ввода, тоже срезаем. Всё в координатах коробки (до масштаба). */
function flight(f, rect, r, area) {
  var k = Math.max(f.width / rect.width, f.height / rect.height);
  var left = f.left + (f.width - rect.width * k) / 2, top = f.top + (f.height - rect.height * k) / 2;
  var cut = function (x) { return Math.max(0, x) / k + 'px'; };
  var t = f.top - top + (area ? Math.max(0, area.top - f.top) : 0);
  var b = top + rect.height * k - f.bottom + (area ? Math.max(0, f.bottom - area.bottom) : 0);
  return {
    transform: 'translate3d(' + (left - rect.left) + 'px,' + (top - rect.top) + 'px,0) scale(' + k + ')',
    clip: 'inset(' + cut(t) + ' ' + cut(left + rect.width * k - f.right) + ' ' + cut(b) + ' ' + cut(f.left - left) + ' round ' + r / k + 'px)',
  };
}
var CLIP_NONE = 'inset(0px 0px 0px 0px round 0px)';
/* видимая область ленты: прокрутка минус стеклянные шапка и композер над ней */
function visibleArea(el) {
  var sc = el.parentElement;
  while (sc && sc !== document.body) { var o = getComputedStyle(sc).overflowY; if (o === 'auto' || o === 'scroll') break; sc = sc.parentElement; }
  var r = sc && sc !== document.body ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
  var top = r.top, bottom = r.bottom, host = sc && sc.parentElement;
  var head = host && host.querySelector('.rl-glassbar'), comp = host && host.querySelector('.rl-composer');
  if (head) top = Math.max(top, head.getBoundingClientRect().bottom);
  if (comp) bottom = Math.min(bottom, comp.getBoundingClientRect().top);
  return { top: top, bottom: bottom };
}
function MediaViewer(props) {
  var idx = useState(props.index || 0);
  var items = props.items || [];
  var i = Math.min(idx[0], Math.max(0, items.length - 1));   // список мог укоротиться (фото удалили)
  var it = items[i] || {};
  useEffect(function () { if (props.onIndex) props.onIndex(i); }, [i]);
  useEffect(function () { if (!items.length && props.onClose) props.onClose(); }, [items.length]);
  var closing = useState(false);
  var tick = useState(0);
  var root = useRef(null), box = useRef(null), hidden = useRef(null), closeRef = useRef(null);
  var real = !!it.src;
  var rect = real && it.w && it.h ? viewerRect(it.w, it.h) : null;
  // качество видео (как в Telegram): it.qualities — [{ label: '720p', src }, { label: 'Оригинал', src }], первое — по умолчанию.
  // Выбор помним до закрытия просмотра; при переключении то же место и пауза/игра сохраняются.
  var quality = useState(0), resume = useRef(null), videoEl = useRef(null);
  var qs = it.kind === 'video' && it.qualities && it.qualities.length > 1 ? it.qualities : null;
  var q = qs ? qs[Math.min(quality[0], qs.length - 1)] : null;
  var videoSrc = q ? q.src : it.src;
  useVideoRecovery(videoEl, real && it.kind === 'video' ? videoSrc : null);
  function switchQuality(k) {
    var v = videoEl.current;
    resume.current = v ? { t: v.currentTime, paused: v.paused } : null;
    quality[1](function (x) { return typeof k === 'number' ? k : (x + 1) % qs.length; });
  }
  function source(k) { return props.origin ? props.origin(k) : null; }
  function hide(el) {   // скрыть миниатюру под просмотром (прежнюю — вернуть); только в фазе записи
    if (hidden.current && hidden.current !== el) hidden.current.style.visibility = '';
    hidden.current = el || null;
    if (el) el.style.visibility = 'hidden';
  }

  // открытие: до первой отрисовки ставим коробку на место миниатюры, кадром позже — отпускаем
  useLayoutEffect(function () {
    var el = root.current, b = box.current, from = source(i);
    if (!b || !rect || !from || reducedMotion()) { if (el) el.classList.remove('rl-viewer-pre'); if (from) hide(from); return; }
    var end = beginHeavyAnimation(VIEWER_MS);
    forceMeasure(function () {
      var f = from.getBoundingClientRect(), r = parseFloat(getComputedStyle(from).borderTopLeftRadius) || 0;
      var fl = flight(f, rect, r, visibleArea(from));
      b.style.transition = 'none';
      b.style.transform = fl.transform;
      b.style.clipPath = fl.clip;
      hide(from);
    });
    var raf = requestAnimationFrame(function () { requestMutation(function () {
      b.style.transition = ''; b.style.transform = ''; b.style.clipPath = CLIP_NONE;
      el.classList.remove('rl-viewer-pre');
    }); });
    return function () { cancelAnimationFrame(raf); end(); };
  }, []);

  // листание: прячем миниатюру текущего фото, прежнюю показываем
  useEffect(function () { var el = source(i); requestMutation(function () { if (!closing[0]) hide(el); }); }, [i]);
  // уход со страницы просмотра без анимации — миниатюру вернуть
  useEffect(function () { return function () { if (hidden.current) hidden.current.style.visibility = ''; }; }, []);
  useEffect(function () {
    var onResize = function () { tick[1](function (x) { return x + 1; }); };
    addEventListener('resize', onResize);
    return function () { removeEventListener('resize', onResize); };
  }, []);

  function close() {
    if (closing[0] || closeRef.current) return;
    closeRef.current = true;
    closing[1](true);
    var b = box.current, el = root.current, to = source(i);
    var done = function () { requestMutation(function () { hide(null); }); if (props.onClose) props.onClose(); };
    if (!b || !el || reducedMotion()) { done(); return; }
    var end = beginHeavyAnimation(VIEWER_MS);
    requestMeasure(function () {
      var f = to && to.getBoundingClientRect(), area = to && visibleArea(to);
      var partly = f && f.bottom > area.top && f.top < area.bottom;
      var r = to ? parseFloat(getComputedStyle(to).borderTopLeftRadius) || 0 : 0;
      requestMutation(function () {
        el.classList.add('rl-viewer-leaving');
        if (rect && partly) {   // летим обратно в миниатюру: срез по плитке, а если её частично закрыли шапка/поле ввода — и по видимой части
          hide(to);
          if (!b.style.clipPath) { b.style.clipPath = CLIP_NONE; b.getBoundingClientRect(); }   // открылось без полёта — начальная точка перехода
          var fl = flight(f, rect, r, area);
          b.style.transform = fl.transform;
          b.style.clipPath = fl.clip;
        } else {
          b.style.opacity = '0';
          if (rect) b.style.transform = 'translate3d(' + rect.width * 0.04 + 'px,' + rect.height * 0.04 + 'px,0) scale(0.92)';   // к центру: origin коробки — левый верх
        }
        setTimeout(function () { end(); done(); }, VIEWER_MS + 20);
      });
    });
  }
  function go(d) { idx[1](function (x) { return Math.min(items.length - 1, Math.max(0, x + d)); }); }
  // клавиши — где бы ни был фокус
  useEffect(function () {
    var onKey = function (e) {
      // в видео стрелки мотают (плеер), а не листают
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && real && it.kind === 'video') return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    addEventListener('keydown', onKey, true);
    return function () { removeEventListener('keydown', onKey, true); };
  });
  if (props.open === false) return null;

  var media = real
    ? h('div', { class: 'rl-viewer-box', ref: box, style: rect ? { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' } : null },
        it.thumb ? h('img', { class: 'rl-viewer-thumb', src: it.thumb, alt: '', 'aria-hidden': 'true' }) : null,
        it.kind === 'video'
          // видео из сообщения: свой плеер (полоса, громкость, скорость, качество, PiP, во весь экран, клавиши)
          ? h(VideoPlayer, { src: videoSrc, videoRef: videoEl, poster: it.thumb || undefined,
              qualities: qs, quality: qs ? Math.min(quality[0], qs.length - 1) : 0, onQuality: switchQuality,
              onLoadedMetadata: function (e) { var r = resume.current, v = e.currentTarget; resume.current = null; if (!r) return; v.currentTime = r.t; if (r.paused) v.pause(); } })
          : h('img', { class: 'rl-viewer-img', src: it.src, alt: it.caption || '', decoding: 'async' }),
        // видео-аватарка и т.п.: зацикленное видео без звука поверх кадра-обложки
        it.video ? h('video', { key: it.video, class: 'rl-viewer-img rl-viewer-loop', src: it.video, autoPlay: true, loop: true, muted: true, playsInline: true, disablePictureInPicture: true }) : null)
    : h('figure', { key: i, class: 'rl-viewer-media' },
        h(MediaArt, { seed: it.seed }),
        it.kind === 'video' ? h('span', { class: 'rl-media-center' }, h('span', { class: 'rl-media-play rl-media-play-lg' }, h(Icon, { name: 'play', size: 34 }))) : null,
        it.caption ? h('figcaption', null, it.caption) : null);

  var tree = h('div', { class: cx('rl-viewer', real && 'rl-viewer-photo', real && rect && props.origin && 'rl-viewer-pre'), role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Просмотр медиа', tabIndex: -1,
      ref: function (n) { root.current = n; if (n && document.activeElement === document.body) n.focus(); } },
    h('div', { class: 'rl-viewer-backdrop', onClick: real ? close : undefined }),
    h('div', { class: 'rl-viewer-top' },
      h(Avatar, Object.assign({ name: it.sender != null ? it.sender : props.sender, size: 40 }, it.avatar || props.avatar)),   // автор этого фото, а не собеседник
      h('div', { class: 'rl-viewer-who' }, h('b', null, it.sender != null ? it.sender : props.sender), h('span', null, it.date || props.date)),
      // свои действия (фото профиля: «сделать главным», «удалить») вместо действий над сообщением
      props.actions ? props.actions(it, i).map(function (a) {
        return h(IconButton, { key: a.label, icon: a.icon, label: a.label, class: a.danger ? 'rl-viewer-danger' : undefined, onClick: a.onClick });
      }) : [h(IconButton, { key: 'z', icon: 'zoomIn', label: 'Увеличить' }), h(IconButton, { key: 'r', icon: 'reply', label: 'Ответить' })],
      real ? h('a', { class: 'rl-iconbtn', href: it.download || it.src, download: it.name || '', 'aria-label': 'Скачать', title: 'Скачать' }, h(Icon, { name: 'download', size: 24 })) : h(IconButton, { icon: 'download', label: 'Скачать' }),
      h(IconButton, { icon: 'close', label: 'Закрыть', onClick: close })),
    real ? media : null,
    h('div', { class: 'rl-viewer-stage' },
      h(IconButton, { icon: 'chevronLeft', label: 'Предыдущее', filled: true, class: 'rl-viewer-nav', disabled: i === 0, onClick: function () { go(-1); } }),
      // видео: середина пропускает клики к плееру (мимо видео закрывает фон под ним)
      real ? h('div', { class: cx('rl-viewer-spacer', it.kind === 'video' && 'rl-viewer-spacer-pass'), onClick: close }) : media,
      h(IconButton, { icon: 'chevronRight', label: 'Следующее', filled: true, class: 'rl-viewer-nav', disabled: i === items.length - 1, onClick: function () { go(1); } })),
    real && it.caption ? h('div', { class: 'rl-viewer-caption' }, it.caption) : null,
    real ? null : h('div', { class: 'rl-viewer-strip' }, items.map(function (x, k) {
      return h(MediaThumb, { key: k, seed: x.seed, kind: x.kind, size: 56, selected: k === i, onClick: function () { idx[1](k); } });
    })));
  // фото — поверх всего окна (сайдбар тоже), как в Telegram: порталом в body, вне стеков колонок
  return real && typeof document !== 'undefined' ? createPortal(tree, document.body) : tree;
}

/* =====================================================================
   Info panel (contact / group info)
   ===================================================================== */
function Switch(props) {
  var id = props.id || 'rl-switch';
  return h('label', { class: 'rl-switch', for: id },
    h('input', { id: id, type: 'checkbox', role: 'switch', checked: props.checked, defaultChecked: props.defaultChecked, onChange: props.onChange, 'aria-label': props.label }),
    h('span', { class: 'rl-switch-track', 'aria-hidden': 'true' }, h('span', { class: 'rl-switch-knob' })));
}
function PanelHeader(props) {
  // как в Telegram: пока панель не прокручена, шапка сливается с фоном; содержимое уехало под неё —
  // шапка становится цвета карточки с линией снизу (слушаем прокрутку соседей внутри той же панели)
  var ref = useRef(null);
  var scrolled = useState(false);   // в состоянии, а не classList: перерисовка (смена заголовка) класс не сотрёт
  useEffect(function () {
    var head = ref.current, host = head && head.parentElement;
    if (!host) return;
    var on = false;
    var onScroll = function (e) {
      var t = e.target;
      if (!t || t === document || !host.contains(t) || head.contains(t)) return;
      var next = t.scrollTop > 2;
      if (next !== on) { on = next; scrolled[1](on); }
    };
    host.addEventListener('scroll', onScroll, true);
    return function () { host.removeEventListener('scroll', onScroll, true); };
  }, []);
  return h('div', { ref: ref, class: cx('rl-panel-head', scrolled[0] && 'is-scrolled', props.class) },
    h(IconButton, { key: props.icon || 'close', icon: props.icon || 'close', label: props.closeLabel || 'Закрыть', onClick: props.onClose, class: 'rl-panel-head-btn' }),
    // смена заголовка (например «Информация» → «Общие медиа») — с мягким проявлением нового текста
    h('h2', null, h('span', { key: String(props.title), class: 'rl-panel-head-title' }, props.title)),
    props.action ? h(IconButton, { icon: props.action.icon, label: props.action.label, onClick: props.action.onClick }) : null,
    props.actions ? props.actions.map(function (a, i) { return h(IconButton, { key: i, icon: a.icon, label: a.label, onClick: a.onClick, 'aria-haspopup': a.popup ? 'menu' : undefined }); }) : null);
}
function ProfileHeader(props) {
  return h('div', { class: 'rl-profile' },
    props.onAvatar
      ? h('button', { type: 'button', class: cx('rl-profile-ava', props.busy && 'is-busy'), 'aria-label': props.avatarLabel || 'Изменить фото', onClick: props.onAvatar },
          h(Avatar, { name: props.name, src: props.src, thumb: props.thumb, tone: props.tone, size: props.size || 120 }),
          props.camera === false ? null : h('span', { class: 'rl-profile-ava-cam', 'aria-hidden': 'true' }, h(Icon, { name: 'camera', size: Math.round((props.size || 120) * 0.3) })),
          props.busy ? h('svg', { class: 'rl-profile-ava-ring', viewBox: '0 0 100 100', 'aria-hidden': 'true' }, h('circle', { cx: 50, cy: 50, r: 48 })) : null)
      : h(Avatar, { name: props.name, src: props.src, thumb: props.thumb, tone: props.tone, size: props.size || 120 }),
    h('div', { class: 'rl-profile-name' }, props.name),
    h('div', { class: 'rl-profile-sub' }, props.subtitle, props.accent ? [' · ', h('b', { key: 'a' }, props.accent)] : null),
    props.actions ? h('div', { class: 'rl-profile-actions' }, props.actions) : null);
}
function ActionTile(props) {
  return h('button', { type: 'button', class: 'rl-tile', onPointerDown: ripple, onClick: props.onClick },
    h('span', { class: 'rl-tile-icon' }, h(Icon, { name: props.icon, size: 24 })), h('span', null, props.label));
}
// Цветная плитка 32×32 с белой иконкой; color — blue|orange|red|gray|green|purple|pink
function SettingsIcon(props) {
  // в цветной плитке значок залитый, как у Telegram; у значков из одних линий заливать нечего — контур потолще
  var filled = PACK_FILLED[props.icon + 'Filled'] ? props.icon + 'Filled' : null;
  return h('span', { class: cx('rl-sicon', 'rl-sicon-' + (props.color || 'blue')), 'aria-hidden': 'true' }, h(Icon, { name: filled || props.icon, size: 18, strokeWidth: filled ? 1.8 : 2 }));
}
function InfoRow(props) {
  var withSwitch = !!(props.trailing && props.trailing.type === Switch);
  var Tag = withSwitch ? 'div' : 'button';
  var off = withSwitch && props.trailing.props.disabled;
  // строка с переключателем (как в Telegram): клик в любом месте строки — это клик по переключателю;
  // сам переключатель — label, его клик доходит сюда всплытием, второй раз не жмём
  function onSwitchRow(e) {
    if (e.target.closest && e.target.closest('.rl-switch')) return;
    if (props.onClick) { props.onClick(e); return; }
    var input = e.currentTarget.querySelector('.rl-switch input');
    if (input && !input.disabled) input.click();
  }
  return h(Tag, { type: Tag === 'button' ? 'button' : undefined, class: cx('rl-inforow', withSwitch && 'rl-inforow-switch', off && 'rl-inforow-off', props.danger && 'rl-inforow-danger'), onPointerDown: off ? undefined : ripple, onClick: withSwitch ? onSwitchRow : props.onClick },
    props.tile ? h(SettingsIcon, { icon: props.icon, color: props.tile })
      : h('span', { class: 'rl-inforow-icon' }, h(Icon, { name: props.icon, size: 24 })),
    h('span', { class: 'rl-inforow-text' }, h('span', null, props.title), props.subtitle ? h('small', null, props.subtitle) : null),
    props.value != null && props.value !== '' ? h('span', { class: 'rl-inforow-count rl-inforow-value' }, props.value) : null,
    props.count !== undefined ? h('span', { class: 'rl-inforow-count' }, props.count) : null,
    props.trailing || null);
}
function ReadMore(props) {
  var o = useState(false);
  return h('div', { class: cx('rl-readmore', o[0] && 'rl-readmore-open') },
    h('p', null, props.children),
    !o[0] ? h('button', { type: 'button', onClick: function () { o[1](true); } }, props.label || 'Читать дальше') : null);
}

/* =====================================================================
   Motion layer
   ===================================================================== */

/* ---------- Presence: keeps a child mounted while it plays its exit animation ---------- */
function Presence(props) {
  var st = useState(!!props.show);
  var mounted = st[0];
  useEffect(function () {
    var end = beginHeavyAnimation(props.show ? 300 : (props.exitMs || 220));
    if (props.show) { st[1](true); return end; }
    if (!mounted) return;
    var t = setTimeout(function () { st[1](false); }, reducedMotion() ? 0 : (props.exitMs || 220));
    return function () { clearTimeout(t); end(); };
  }, [props.show]);
  if (!mounted && !props.show) return null;
  return h('div', { class: 'rl-presence', 'data-state': props.show ? 'open' : 'closing' }, props.children);
}

/* ---------- useMinVisible: loaders that never flicker ----------
   Turns on only if `want` lasts longer than `delay` (fast loads show nothing),
   and once on stays at least `min` ms so it can fade out instead of blinking. */
function useMinVisible(want, opts) {
  var delay = opts && opts.delay != null ? opts.delay : 150;
  var min = opts && opts.min != null ? opts.min : 600;
  var st = useState(false), on = st[0];
  var since = useRef(0), latest = useRef(want);
  latest.current = want; // таймер может сработать между рендером и эффектом — смотрим на свежее значение
  useEffect(function () {
    var t;
    if (want && !on) t = setTimeout(function () { if (!latest.current) return; since.current = performance.now(); st[1](true); }, delay);
    else if (!want && on) t = setTimeout(function () { st[1](false); }, Math.max(0, min - (performance.now() - since.current)));
    return function () { clearTimeout(t); };
  }, [want, on]);
  return on;
}

/* ---------- FlipList: reorders animate (FLIP), new items fade in ---------- */
function FlipList(props) {
  var ref = useRef(null), prev = useRef(null);
  useLayoutEffect(function () { forceMeasure(function () {
    var el = ref.current;
    if (!el) return;
    // FLIP — осознанное исключение из measure/mutate: «первое» положение надо снять до отрисовки нового кадра,
    // иначе браузер успеет показать строки уже на новых местах. Сначала все чтения, потом все записи.
    // positions inside the list (offsetTop), not in the viewport: scrolling must not count as a move
    var kids = el.children, next = {}, i, k;
    for (i = 0; i < kids.length; i++) { k = kids[i].getAttribute('data-flip'); next[k] = kids[i].offsetTop; } // measure everything first
    if (prev.current && !reducedMotion()) {
      var base = el.getBoundingClientRect().top, vh = window.innerHeight;
      var seen = function (y) { return base + y > -120 && base + y < vh + 120; }; // only rows the user can see
      var moved = false, todo = [];
      for (i = 0; i < kids.length; i++) {
        k = kids[i].getAttribute('data-flip');
        var was = prev.current[k];
        if (was === undefined) { if (seen(next[k])) todo.push([kids[i], null]); }
        else if (Math.abs(was - next[k]) > 1 && (seen(was) || seen(next[k]))) { moved = true; todo.push([kids[i], was - next[k]]); }
      }
      if (moved) beginHeavyAnimation(320);
      for (i = 0; i < todo.length; i++) { // then mutate
        if (todo[i][1] === null) todo[i][0].animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.1, 0.82, 0.25, 1)' });
        else todo[i][0].animate([{ transform: 'translateY(' + todo[i][1] + 'px)' }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
      }
    }
    prev.current = next;
  }); });
  return h('div', { ref: ref, class: (props.className || props.class), style: Object.assign({ position: 'relative' }, props.style), role: props.role },
    toChildArray(props.children).map(function (ch) { return ch ? h('div', { key: ch.key, 'data-flip': ch.key, class: 'rl-flip-item' }, ch) : null; }));
}

/* ---------- SyncIndicator: offline-first state as one animated SVG ---------- */
var SYNC_LABEL = { synced: 'Синхронизировано', syncing: 'Синхронизация…', offline: 'Нет сети', error: 'Ошибка синхронизации' };
function SyncIndicator(props) {
  var s = props.state || 'synced';
  var first = useRef(s);
  var inner =
    s === 'syncing' ? h('g', { key: 'sy', class: 'rl-sync-spin' }, h('path', { d: 'M9.2 13.2a3 3 0 0 1 5.3-1.4' }), h('path', { d: 'M14.8 14.8a3 3 0 0 1-5.3 1.4' }), h('path', { d: 'M14.6 10.6v1.4h-1.4' }), h('path', { d: 'M9.4 17.4V16h1.4' }))
    : s === 'synced' ? h('path', { key: 'ok', class: 'rl-sync-draw', d: 'M9.3 14.3l1.9 1.9 3.7-3.9' })
    : s === 'error' ? h('g', { key: 'er', class: 'rl-sync-pop' }, h('path', { d: 'M12 11.5v2.6' }), h('path', { d: 'M12 16.4h.01' }))
    : h('path', { key: 'off', class: 'rl-sync-draw', d: 'M4 4l16 16' });
  return h('span', { class: cx('rl-sync rl-sync-' + s, s === first.current && 'rl-sync-steady'), role: 'status', 'aria-live': 'polite' },
    h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
      h('path', { class: 'rl-sync-cloud', d: ICONS.cloud[0] }), inner),
    props.label === false ? null : h('span', { key: s, class: 'rl-sync-label' }, props.label || SYNC_LABEL[s]));
}

/* ---------- LinearProgress: «Подключение…» bar (WDS: translate + scaleX sweep) ---------- */
function LinearProgress(props) {
  var det = typeof props.value === 'number';
  return h('div', { class: cx('rl-linear', !det && 'rl-linear-indet'), role: 'progressbar', 'aria-label': props.label || 'Подключение', 'aria-valuenow': det ? Math.round(props.value * 100) : undefined },
    h('span', { style: det ? { transform: 'scaleX(' + props.value + ')' } : null }));
}

/* ---------- EmptyState: drawn-in SVG illustration ---------- */
function EmptyState(props) {
  var kind = props.kind || 'chats';
  var L = function (cls, attrs) { return h(attrs.tag || 'path', Object.assign({ class: 'rl-empty-line ' + (cls || ''), pathLength: 1 }, attrs, { tag: undefined })); };
  // искорка: четырёхлучевая звёздочка с вогнутыми гранями (не «×» — не путать с «закрыть»)
  var spark = function (x, y, cls) {
    var r = 6, c = 1.2;
    return h('path', { class: 'rl-empty-spark ' + (cls || ''), d: 'M' + x + ' ' + (y - r) + 'Q' + (x + c) + ' ' + (y - c) + ' ' + (x + r) + ' ' + y + 'Q' + (x + c) + ' ' + (y + c) + ' ' + x + ' ' + (y + r) + 'Q' + (x - c) + ' ' + (y + c) + ' ' + (x - r) + ' ' + y + 'Q' + (x - c) + ' ' + (y - c) + ' ' + x + ' ' + (y - r) + 'Z' });
  };
  var art = kind === 'media'
    // две фотокарточки: на передней горы и солнце, которое всходит; вокруг мерцают искорки
    ? h('svg', { class: 'rl-empty-art', viewBox: '0 0 160 120', 'aria-hidden': 'true' },
      h('g', { class: 'rl-empty-float rl-empty-float-2' },
        h('rect', { class: 'rl-empty-fill rl-empty-fill-in', x: 26, y: 20, width: 70, height: 56, rx: 9, transform: 'rotate(-9 61 48)' }),
        L('', { tag: 'rect', x: 26, y: 20, width: 70, height: 56, rx: 9, transform: 'rotate(-9 61 48)' })),
      h('g', { class: 'rl-empty-float' },
        h('rect', { class: 'rl-empty-fill rl-empty-fill-out', x: 54, y: 36, width: 80, height: 62, rx: 9 }),
        L('rl-empty-d2', { tag: 'rect', x: 54, y: 36, width: 80, height: 62, rx: 9 }),
        h('g', { class: 'rl-empty-sun' }, h('circle', { class: 'rl-empty-sun-fill', cx: 112, cy: 56, r: 7 }), L('rl-empty-d3', { tag: 'circle', cx: 112, cy: 56, r: 7 })),
        L('rl-empty-d3', { d: 'M60 90l20-22 13 13 9-8 26 17' })),
      spark(140, 26), spark(20, 88, 'rl-empty-spark-2'), spark(146, 104, 'rl-empty-spark-3'))
    : kind === 'files'
    // документ с загнутым уголком, за ним второй; скрепка покачивается, «скачать» подпрыгивает
    ? h('svg', { class: 'rl-empty-art', viewBox: '0 0 160 120', 'aria-hidden': 'true' },
      h('g', { class: 'rl-empty-float rl-empty-float-2' },
        h('path', { class: 'rl-empty-fill rl-empty-fill-in', d: 'M66 14h40a6 6 0 0 1 6 6v64a6 6 0 0 1-6 6H66a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6z', transform: 'rotate(8 86 52)' }),
        L('', { d: 'M66 14h40a6 6 0 0 1 6 6v64a6 6 0 0 1-6 6H66a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6z', transform: 'rotate(8 86 52)' })),
      h('g', { class: 'rl-empty-float' },
        h('path', { class: 'rl-empty-fill rl-empty-fill-out', d: 'M52 24h38l18 18v56a6 6 0 0 1-6 6H52a6 6 0 0 1-6-6V30a6 6 0 0 1 6-6z' }),
        L('rl-empty-d2', { d: 'M52 24h38l18 18v56a6 6 0 0 1-6 6H52a6 6 0 0 1-6-6V30a6 6 0 0 1 6-6z' }),
        L('rl-empty-d2', { d: 'M90 24v12a6 6 0 0 0 6 6h12' }),
        L('rl-empty-d3', { d: 'M58 60h36' }), L('rl-empty-d3', { d: 'M58 72h36' }), L('rl-empty-d3', { d: 'M58 84h22' }),
        h('g', { class: 'rl-empty-clip' }, L('rl-empty-d3', { d: 'M60 12v22a7 7 0 0 0 14 0V10a5 5 0 0 0-10 0v22' }))),
      h('g', { class: 'rl-empty-bob' },
        h('circle', { class: 'rl-empty-fill rl-empty-fill-in', cx: 122, cy: 94, r: 13 }),
        L('rl-empty-d3', { tag: 'circle', cx: 122, cy: 94, r: 13 }),
        L('rl-empty-d3', { d: 'M122 87v13M116.5 95l5.5 5.5 5.5-5.5' })),
      spark(28, 30), spark(136, 22, 'rl-empty-spark-2'))
    : kind === 'links'
    // два звена цепи сходятся и сцепляются; в точке сцепки вспыхивает искорка
    ? h('svg', { class: 'rl-empty-art', viewBox: '0 0 160 120', 'aria-hidden': 'true' },
      h('circle', { class: 'rl-empty-fill rl-empty-fill-soft', cx: 80, cy: 60, r: 46 }),
      h('g', { transform: 'rotate(-35 80 60)' },
        h('g', { class: 'rl-empty-link-a' },
          h('rect', { class: 'rl-empty-fill rl-empty-fill-out', x: 34, y: 48, width: 54, height: 24, rx: 12 }),
          L('', { tag: 'rect', x: 34, y: 48, width: 54, height: 24, rx: 12 })),
        h('g', { class: 'rl-empty-link-b' },
          L('rl-empty-d2', { tag: 'rect', x: 72, y: 48, width: 54, height: 24, rx: 12 }))),
      h('g', { class: 'rl-empty-link-spark' }, spark(80, 60)),
      spark(132, 24, 'rl-empty-spark-2'), spark(26, 96, 'rl-empty-spark-3'))
    : kind === 'contacts'
    // двое: задний чуть выше и покачивается не в такт переднему; рядом подпрыгивает «+», вокруг мерцают искорки
    ? h('svg', { class: 'rl-empty-art', viewBox: '0 0 160 120', 'aria-hidden': 'true' },
      h('circle', { class: 'rl-empty-fill rl-empty-fill-soft', cx: 78, cy: 62, r: 46 }),
      h('g', { class: 'rl-empty-float rl-empty-float-2' },
        h('path', { class: 'rl-empty-fill rl-empty-fill-in', d: 'M30 88a26 26 0 0 1 52 0z' }),
        h('circle', { class: 'rl-empty-fill rl-empty-fill-in', cx: 56, cy: 42, r: 13 }),
        L('', { tag: 'circle', cx: 56, cy: 42, r: 13 }),
        L('', { d: 'M30 88a26 26 0 0 1 52 0' })),
      h('g', { class: 'rl-empty-float' },
        h('path', { class: 'rl-empty-fill rl-empty-fill-out', d: 'M64 104a30 30 0 0 1 60 0z' }),
        h('circle', { class: 'rl-empty-fill rl-empty-fill-out', cx: 94, cy: 52, r: 16 }),
        L('rl-empty-d2', { tag: 'circle', cx: 94, cy: 52, r: 16 }),
        L('rl-empty-d2', { d: 'M64 104a30 30 0 0 1 60 0' })),
      h('g', { class: 'rl-empty-bob' },
        h('circle', { class: 'rl-empty-fill rl-empty-fill-in', cx: 132, cy: 34, r: 12 }),
        L('rl-empty-d3', { tag: 'circle', cx: 132, cy: 34, r: 12 }),
        L('rl-empty-d3', { d: 'M132 28.5v11M126.5 34h11' })),
      spark(28, 26), spark(146, 76, 'rl-empty-spark-2'), spark(20, 100, 'rl-empty-spark-3'))
    : kind === 'search'
    ? h('svg', { class: 'rl-empty-art', viewBox: '0 0 160 120', 'aria-hidden': 'true' },
      h('circle', { class: 'rl-empty-fill rl-empty-fill-in', cx: 70, cy: 56, r: 30 }),
      h('circle', { class: 'rl-empty-line', cx: 70, cy: 56, r: 30, pathLength: 1 }),
      h('path', { class: 'rl-empty-line rl-empty-d2', d: 'M92 78l26 26', pathLength: 1 }),
      h('path', { class: 'rl-empty-line rl-empty-d3', d: 'M58 56h24', pathLength: 1 }))
    : h('svg', { class: 'rl-empty-art', viewBox: '0 0 160 120', 'aria-hidden': 'true' },
      h('g', { class: 'rl-empty-float' },
        h('path', { class: 'rl-empty-fill rl-empty-fill-in', d: 'M20 22h78a8 8 0 0 1 8 8v30a8 8 0 0 1-8 8H38l-14 12V68h-4a8 8 0 0 1-8-8V30a8 8 0 0 1 8-8z' }),
        h('path', { class: 'rl-empty-line', pathLength: 1, d: 'M20 22h78a8 8 0 0 1 8 8v30a8 8 0 0 1-8 8H38l-14 12V68h-4a8 8 0 0 1-8-8V30a8 8 0 0 1 8-8z' }),
        h('path', { class: 'rl-empty-line rl-empty-d2', pathLength: 1, d: 'M28 38h56' }),
        h('path', { class: 'rl-empty-line rl-empty-d3', pathLength: 1, d: 'M28 50h36' })),
      h('g', { class: 'rl-empty-float rl-empty-float-2' },
        h('path', { class: 'rl-empty-fill rl-empty-fill-out', d: 'M66 66h74a8 8 0 0 1 8 8v20a8 8 0 0 1-8 8h-4v12l-14-12H66a8 8 0 0 1-8-8V74a8 8 0 0 1 8-8z' }),
        h('path', { class: 'rl-empty-line rl-empty-d2', pathLength: 1, d: 'M66 66h74a8 8 0 0 1 8 8v20a8 8 0 0 1-8 8h-4v12l-14-12H66a8 8 0 0 1-8-8V74a8 8 0 0 1 8-8z' }),
        h('circle', { class: 'rl-empty-dot', cx: 92, cy: 84, r: 3.5 }), h('circle', { class: 'rl-empty-dot', cx: 104, cy: 84, r: 3.5 }), h('circle', { class: 'rl-empty-dot', cx: 116, cy: 84, r: 3.5 })));
  return h('div', { class: 'rl-empty' }, art,
    h('div', { class: 'rl-empty-title' }, props.title),
    props.text ? h('div', { class: 'rl-empty-text' }, props.text) : null,
    props.action || null);
}

/* ---------- ScrollToBottom: FAB over the feed with unread count ---------- */
function ScrollToBottom(props) {
  return h(Presence, { show: !!props.show, exitMs: 160 },
    h('button', { type: 'button', class: 'rl-fab rl-fab-down', onPointerDown: ripple, onClick: props.onClick, 'aria-label': 'К последним сообщениям' },
      h(Icon, { name: 'arrowDown', size: 24 }),
      props.unread ? h(Badge, { count: props.unread }) : null));
}


export { WebPage, MsgLine, ForwardTitle, peerTone, RelayLogo, Verified, ArchivedRow, ReplyQuote, ReactionChips, cx, chain, ripple, reducedMotion, omit, fmtTime, makeWave, ICONS, Icon, Button, IconButton, Avatar, Badge, Chip, ChatRow, ChatRowSkeleton, Bubble, MessageStatus, TypingIndicator, DateDivider, Banner, NavRail, Checkbox, Toast, Card, Steps, MediaArt, ProgressRing, Waveform, VoiceMessage, VoiceRecorder, MediaBubble, MediaPolicy, mediaHeld, FileBubble, MediaThumb, MediaViewer, Switch, PanelHeader, ProfileHeader, ActionTile, InfoRow, SettingsIcon, ReadMore, Presence, useMinVisible, LazyImage, LazyRoot, lazyObserve, lazyRoots, FlipList, SyncIndicator, LinearProgress, EmptyState, ScrollToBottom };
