import { h, Fragment, toChildArray } from 'preact';
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { MentionList, AttachMenu } from './more.js';
import { requestMeasure, requestMutation, beginHeavyAnimation, onHeavyAnimationEnd, isHeavyAnimating } from './schedule.js';

/* Relay UI kit — Preact. Ported 1:1 from the original kit; see index.js for the public surface. */


function cx() {
  var out = [];
  for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
  return out.join(' ');
}
/* ---------- Motion helpers ---------- */
function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
function chain(a, b) { return function (e) { if (a) a(e); if (b) b(e); }; }
// Pointer ripple: one measure (rect) then one mutation (append), in that order — the fasterdom rule.
function ripple(e) {
  var el = e.currentTarget;
  if (!el || el.disabled || reducedMotion()) return;
  var x = e.clientX, y = e.clientY, released = false, dot = null;
  function done() {
    released = true;
    window.removeEventListener('pointerup', done); window.removeEventListener('pointercancel', done);
    if (dot) requestMutation(function () { dot.classList.add('rl-ripple-out'); setTimeout(function () { dot.remove(); }, 400); });
  }
  window.addEventListener('pointerup', done); window.addEventListener('pointercancel', done);
  // measure in the measure phase, append in the mutation phase of the same frame
  requestMeasure(function () {
    var r = el.getBoundingClientRect();
    requestMutation(function () {
      var host = el.querySelector(':scope > .rl-ripple-host');
      if (!host) { host = document.createElement('span'); host.className = 'rl-ripple-host'; el.appendChild(host); }
      var d = Math.max(r.width, r.height) * 2.2;
      dot = document.createElement('span');
      dot.className = 'rl-ripple' + (released ? ' rl-ripple-out' : '');
      dot.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (x - r.left - d / 2) + 'px;top:' + (y - r.top - d / 2) + 'px';
      host.appendChild(dot);
      if (released) setTimeout(function () { dot.remove(); }, 500);
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
  bellOff: ['M6.3 6.3A6 6 0 0 0 6 8v4l-2 4h12', 'M9 4a6 6 0 0 1 9 5v3l1 2', 'M10 20a2 2 0 0 0 4 0', 'M3 3l18 18'],
  lock: ['M6 11h12v10H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  download: ['M12 4v11', 'M7.5 10.5L12 15l4.5-4.5', 'M5 20h14'],
  chevronRight: ['M9 6l6 6-6 6'],
  arrowLeft: ['M19 12H5', 'M11 6l-6 6 6 6'],
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
  qr: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h2v2h-2z', 'M18 18h2v2h-2z', 'M14 18h2', 'M18 14h2'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  cloud: ['M7 19h10.5a4.5 4.5 0 0 0 .6-8.96A6.5 6.5 0 0 0 5.6 9.6 4.75 4.75 0 0 0 7 19z'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
  pencil: ['M4 20l1-5L16 4l4 4L9 19z', 'M14 6l4 4'],
  userPlus: [C(9, 8, 3.5), 'M2 20a7 7 0 0 1 14 0', 'M19 8v6', 'M16 11h6'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 20a2 2 0 0 0 4 0'],
  timer: ['M12 21a9 9 0 1 0-9-9', 'M12 7v5l3 2', 'M3 16h.01', 'M5.5 19.5h.01'],
  shield: ['M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z'],
  upload: ['M12 20V9', 'M7.5 13.5L12 9l4.5 4.5', 'M5 4h14']
};
var HEAVY = { more: 1, 'M12 16h.01': 1, pause: 1 };
var FILLED = { play: 1, stop: 1 };

function Icon(props) {
  var name = props.name, size = props.size || 20, title = props.title;
  var d = ICONS[name] || ICONS.info;
  var sw = props.strokeWidth || (HEAVY[name] ? 3 : 1.8);
  return h('svg', {
    class: cx('rl-icon', (props.className || props.class)), width: size, height: size, viewBox: '0 0 24 24', fill: FILLED[name] ? 'currentColor' : 'none',
    stroke: 'currentColor', 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    role: title ? 'img' : undefined, 'aria-label': title, 'aria-hidden': title ? undefined : 'true', 'data-icon': name
  }, d.map(function (p, i) { return h('path', { key: i, d: p }); }));
}
Icon.names = Object.keys(ICONS);

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
    'aria-label': props.label, title: props.label,
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
function Avatar(props) {
  var size = props.size || 48;
  return h('span', {
    class: cx('rl-avatar', (props.className || props.class)),
    style: { width: size, height: size, fontSize: Math.round(size * 0.36) },
    role: 'img', 'aria-label': props.name || 'Аватар'
  },
    props.src ? h('img', { src: props.src, alt: '' })
      : props.name ? initials(props.name)
        : h(Icon, { name: 'community', size: Math.round(size * 0.5) }),
    props.online ? h('span', { class: 'rl-avatar-dot', 'aria-hidden': 'true' }) : null);
}

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

/* ---------- SearchField ---------- */
function SearchField(props) {
  var id = props.id || 'rl-search';
  // status: «Подключение…», «Обновление…» — лупа сменяется лоадером, текст встаёт на место плейсхолдера
  var busy = !!props.status;
  return h('div', { class: cx('rl-search', busy && 'rl-search-busy', (props.className || props.class)) },
    h('label', { for: id, class: 'rl-sr' }, props.label || 'Поиск'),
    h('span', { class: 'rl-search-icon', 'aria-hidden': 'true' },
      h(Icon, { name: 'search', size: 18 }),
      h('svg', { class: 'rl-search-spin', width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none' },
        h('circle', { cx: 9, cy: 9, r: 7, stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-dasharray': '30 44' }))),
    h('input', { id: id, type: 'search', placeholder: busy ? props.status : (props.placeholder || 'Поиск или новый чат'), value: props.value, onInput: props.onInput || props.onChange, autocomplete: 'off' }),
    busy ? h('span', { class: 'rl-sr', role: 'status' }, props.status) : null);
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
  var rest = omit(props, ['name', 'preview', 'time', 'unread', 'muted', 'status', 'active', 'typing', 'online', 'avatar', 'author', 'pinned', 'draft', 'mentioned', 'className', 'class']);
  var bottom = props.typing
    ? h('span', { class: 'rl-row-preview rl-row-typing' }, h(TypingIndicator, { inline: true }), 'печатает…')
    : props.draft
      ? h('span', { class: 'rl-row-preview' }, h('b', { class: 'rl-row-draft' }, 'Черновик: '), props.draft)
      : [
        props.status ? h(MessageStatus, { key: 's', status: props.status, size: 15 }) : null,
        h('span', { key: 'p', class: 'rl-row-preview' }, props.author ? props.author + ': ' : '', props.preview)
      ];
  return h('button', Object.assign({ type: 'button' }, rest, { onPointerDown: chain(rest.onPointerDown, ripple),
    class: cx('rl-row', (props.className || props.class)), 'aria-current': props.active ? 'true' : undefined
  }),
    h(Avatar, { name: props.avatar === undefined ? props.name : props.avatar, online: props.online }),
    h('span', { class: 'rl-row-main' },
      h('span', { class: 'rl-row-top' },
        h('span', { class: 'rl-row-name' }, props.name),
        h('span', { class: cx('rl-row-time', unread > 0 && !props.muted && 'rl-row-time-unread') }, props.time)),
      h('span', { class: 'rl-row-bottom' }, bottom,
        h('span', { class: 'rl-row-meta' },
          props.mentioned ? h('span', { class: 'rl-row-at', 'aria-label': 'Вас упомянули' }, '@') : null,
          props.muted ? h(Icon, { name: 'bellOff', size: 16, title: 'Без звука' }) : null,
          props.pinned ? h(Icon, { name: 'pin', size: 16, title: 'Закреплён', class: 'rl-row-pin' }) : null,
          unread > 0 ? h(Badge, { count: unread, muted: props.muted }) : null))));
}

/* ---------- ArchivedRow ---------- */
function ArchivedRow(props) {
  return h('button', { type: 'button', class: 'rl-row rl-row-archived', onPointerDown: ripple, onClick: props.onClick },
    h('span', { class: 'rl-row-archived-icon' }, h(Icon, { name: 'archive', size: 20 })),
    h('span', { class: 'rl-row-name' }, props.label || 'Архив'),
    props.count ? h('span', { class: 'rl-row-time rl-row-time-unread' }, props.count) : null);
}

function ChatRowSkeleton() {
  return h('div', { class: 'rl-skel', 'aria-hidden': 'true' },
    h('i', { style: { width: 48, height: 48 } }),
    h('span', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 8 } },
      h('i', { style: { width: '55%', height: 12 } }),
      h('i', { style: { width: '80%', height: 10 } })));
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
      props.forwarded ? h('span', { class: 'rl-bubble-fwd' }, h(Icon, { name: 'forward', size: 14 }), 'Переслано') : null,
      props.author && !deleted ? h('span', { class: 'rl-bubble-author', style: { color: 'var(--author-' + (props.authorTone || 1) + ')' } }, props.author) : null,
      props.reply && !deleted ? h(ReplyQuote, Object.assign({ inBubble: true }, props.reply)) : null,
      deleted
        ? h('span', { class: 'rl-bubble-text rl-bubble-deleted-text' }, h(Icon, { name: 'ban', size: 16 }), out ? 'Вы удалили это сообщение' : 'Сообщение удалено')
        : h('span', { class: 'rl-bubble-text' }, props.children),
      h('span', { class: cx('rl-bubble-spacer', props.edited && 'rl-bubble-spacer-edited'), 'aria-hidden': 'true' }),
      h('span', { class: 'rl-bubble-meta' },
        props.edited ? h('span', { class: 'rl-bubble-edited' }, 'изм.') : null,
        props.time,
        out && !deleted ? h(MessageStatus, { status: props.status || 'sent' }) : null),
      props.reactions && props.reactions.length ? h(ReactionChips, { items: props.reactions, out: out, onClick: props.onReactionClick }) : null);
  return h('div', {
    class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap', props.selectable && 'rl-msgline-select', props.selected && 'rl-msgline-selected'),
    onClick: props.selectable ? props.onSelect : undefined
  },
    props.selectable ? h('span', { class: 'rl-msg-check', role: 'checkbox', 'aria-checked': String(!!props.selected), 'aria-label': 'Выбрать сообщение' },
      h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, h('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }))) : null,
    line);
}

/* ---------- ReplyQuote: in a bubble or above the composer ---------- */
function ReplyQuote(props) {
  var tone = 'var(--author-' + (props.tone || 1) + ')';
  return h(props.onClick ? 'button' : 'div', { type: props.onClick ? 'button' : undefined, class: cx('rl-quote', props.inBubble && 'rl-quote-in'), style: { '--quote-tone': tone }, onClick: props.onClick },
    h('span', { class: 'rl-quote-body' },
      h('b', { style: { color: tone } }, props.author),
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
  return h('div', { class: 'rl-date', role: 'separator' }, h('span', null, props.children));
}

/* ---------- Composer ---------- */
function Composer(props) {
  var internal = useState('');
  var attach = useState(false);
  var caret = useState(-1);
  var value = props.value !== undefined ? props.value : internal[0];
  var setValue = function (v) { if (props.onChange) props.onChange(v); if (props.value === undefined) internal[1](v); };
  var hasText = value.trim().length > 0;
  // @mention: the word under the caret that starts with @
  var m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret[0] < 0 ? value.length : caret[0]));
  var mentionList = m && props.members ? props.members.filter(function (x) { return x.name.toLowerCase().indexOf(m[2].toLowerCase()) >= 0; }).slice(0, 5) : null;
  function send() {
    if (!hasText) { if (props.onRecord) props.onRecord(); return; }
    if (props.onSend) props.onSend(value.trim());
    setValue('');
  }
  function pickMention(x) {
    var before = value.slice(0, caret[0] < 0 ? value.length : caret[0]).replace(/@([^\s@]*)$/, '@' + x.name + ' ');
    setValue(before + value.slice(caret[0] < 0 ? value.length : caret[0]));
    caret[1](-1);
  }
  var id = props.id || 'rl-composer';
  return h('div', { class: cx('rl-composer-wrap', (props.className || props.class)) },
    h(Presence, { show: !!props.replyTo, exitMs: 160 },
      h('div', { class: 'rl-composer-reply' }, h(ReplyQuote, Object.assign({}, props.replyTo || {}, { onCancel: props.onCancelReply })))),
    h(Presence, { show: !!(mentionList && mentionList.length), exitMs: 120 },
      h(MentionList, { items: mentionList || [], onPick: pickMention })),
    h(Presence, { show: attach[0], exitMs: 160 },
      h(AttachMenu, { onPick: function (k) { attach[1](false); if (props.onAttach) props.onAttach(k); } })),
    h('div', { class: 'rl-composer' },
      h('div', { class: 'rl-composer-field' },
        h(IconButton, { icon: attach[0] ? 'close' : 'attach', label: attach[0] ? 'Закрыть вложения' : 'Прикрепить', active: attach[0], class: 'rl-attach-toggle', onClick: function () { attach[1](!attach[0]); } }),
        h('label', { for: id, class: 'rl-sr' }, 'Сообщение'),
        h('input', {
          id: id, type: 'text', value: value, placeholder: props.placeholder || 'Введите сообщение', autocomplete: 'off',
          onInput: function (e) { setValue(e.target.value); caret[1](e.target.selectionStart); },
          onKeyDown: function (e) {
            if (e.key === 'Enter' && mentionList && mentionList.length) { e.preventDefault(); pickMention(mentionList[0]); return; }
            if (e.key === 'Enter') { e.preventDefault(); send(); }
            if (e.key === 'Escape' && props.replyTo && props.onCancelReply) props.onCancelReply();
          }
        }),
        h(IconButton, { icon: 'smile', label: 'Эмодзи', class: 'rl-emoji-toggle' })),
      h('button', { type: 'button', onPointerDown: ripple, class: 'rl-composer-send', 'aria-label': hasText ? 'Отправить' : 'Записать голосовое', onClick: send },
        h(Icon, { name: 'send', size: 22, class: hasText ? '' : 'rl-swap-off' }),
        h(Icon, { name: 'mic', size: 22, class: hasText ? 'rl-swap-off' : '' }))));
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

/* ---------- Modal (inline: the consumer positions the scrim's parent) ---------- */
function Modal(props) {
  if (props.open === false) return null;
  return h('div', { class: 'rl-scrim', onClick: function (e) { if (e.target === e.currentTarget && props.onClose) props.onClose(); } },
    h('div', { class: 'rl-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
      props.onClose ? h(IconButton, { icon: 'close', label: 'Закрыть', onClick: props.onClose, class: 'rl-modal-close' }) : null,
      props.icon ? h('div', { class: 'rl-modal-icon' }, h(Icon, { name: props.icon, size: 64, strokeWidth: 1.4 })) : null,
      h('h2', { class: 'rl-modal-title' }, props.title),
      props.children,
      props.actions ? h('div', { class: 'rl-modal-actions' }, props.actions) : null));
}
function Feature(props) {
  return h('div', { class: 'rl-feature' }, h(Icon, { name: props.icon, size: 22 }), h('div', null, props.children));
}
Modal.Feature = Feature;

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
    h('input', { id: id, type: 'checkbox', checked: props.checked, defaultChecked: props.defaultChecked, onChange: props.onChange }),
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
function ProgressRing(props) {
  var size = props.size || 48, r = (size - 6) / 2, c = 2 * Math.PI * r;
  var p = props.progress;
  var det = typeof p === 'number';
  return h('div', { class: cx('rl-ring', !det && 'rl-ring-spin', props.onMedia && 'rl-ring-onmedia'), style: { width: size, height: size }, role: 'progressbar', 'aria-valuenow': det ? Math.round(p * 100) : undefined, 'aria-label': props.label || 'Загрузка' },
    h('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, 'aria-hidden': 'true' },
      h('circle', { class: 'rl-ring-track', cx: size / 2, cy: size / 2, r: r }),
      h('circle', { class: 'rl-ring-arc', cx: size / 2, cy: size / 2, r: r, style: { strokeDasharray: c, strokeDashoffset: det ? c * (1 - p) : c * 0.7 } })),
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
    var rect = e.currentTarget.getBoundingClientRect();
    progRef.current = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    paint();
  }
  function cycleSpeed() { st[1]({ playing: s.playing, played: s.played, speed: (s.speed + 1) % SPEEDS.length }); }

  var thumbColor = !s.played ? (out ? 'var(--voice-new-out)' : 'var(--voice-new)') : 'var(--tick-read)';
  return h('div', { class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
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
      h(Icon, { name: 'send', size: 22 })));
}

/* ---------- MediaBubble: photo, video, album ---------- */
function MediaOverlay(props) {
  // state: 'ready' | 'remote' (not downloaded) | 'loading' | 'uploading'
  if (props.state === 'remote') return h('button', { type: 'button', class: 'rl-media-dl', onClick: props.onDownload }, h(Icon, { name: 'download', size: 18 }), props.size || 'Скачать');
  if (props.state === 'loading' || props.state === 'uploading') return h('div', { class: 'rl-media-center' }, h(ProgressRing, { progress: props.progress, onMedia: true, onCancel: props.onCancel, label: props.state === 'uploading' ? 'Отправка' : 'Загрузка' }));
  if (props.kind === 'video') return h('div', { class: 'rl-media-center' }, h('span', { class: 'rl-media-play' }, h(Icon, { name: 'play', size: 26 })));
  return null;
}
function MediaBubble(props) {
  var out = props.from === 'out';
  var items = props.items || [{ seed: props.seed || 0, kind: props.kind || 'image', duration: props.duration }];
  var album = items.length > 1;
  var state = props.state || 'ready';
  var extra = items.length - 4;
  function cell(it, i) {
    var last = album && i === 3 && extra > 0;
    return h('button', { key: i, type: 'button', class: 'rl-media-cell', onClick: function () { if (props.onOpen && state === 'ready') props.onOpen(i); }, 'aria-label': it.kind === 'video' ? 'Открыть видео' : 'Открыть фото' },
      h(MediaArt, { seed: it.seed, blur: state === 'remote' }),
      it.kind === 'video' && it.duration ? h('span', { class: 'rl-media-chip rl-media-chip-dur' }, h(Icon, { name: 'video', size: 14 }), fmtTime(it.duration)) : null,
      last ? h('span', { class: 'rl-media-more' }, '+' + (extra + 1)) : null,
      !album ? h(MediaOverlay, { state: state, kind: it.kind, progress: props.progress, size: props.size, onDownload: props.onDownload, onCancel: props.onCancel }) : null);
  }
  return h('div', { class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-bubble rl-media', out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && 'rl-bubble-tail', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in')) },
      props.author ? h('span', { class: 'rl-bubble-author rl-media-author', style: { color: 'var(--author-' + (props.authorTone || 1) + ')' } }, props.author) : null,
      h('div', { class: cx('rl-media-frame', album && 'rl-media-album'), style: album ? null : { aspectRatio: props.ratio || '4 / 3' } },
        (album ? items.slice(0, 4) : items).map(cell),
        album && state !== 'ready' ? h(MediaOverlay, { state: state, progress: props.progress, size: props.size, onDownload: props.onDownload, onCancel: props.onCancel }) : null,
        !props.caption ? h('span', { class: 'rl-media-chip rl-media-chip-meta' }, props.time, out ? h(MessageStatus, { status: props.status || 'read' }) : null) : null),
      props.caption ? h('div', { class: 'rl-media-caption' }, props.caption, h('span', { class: 'rl-bubble-spacer', 'aria-hidden': 'true' }),
        h('span', { class: 'rl-bubble-meta' }, props.time, out ? h(MessageStatus, { status: props.status || 'read' }) : null)) : null));
}

/* ---------- FileBubble: documents ---------- */
function FileBubble(props) {
  var out = props.from === 'out';
  var ext = (props.ext || 'pdf').toUpperCase();
  return h('div', { class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-bubble rl-file', out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && 'rl-bubble-tail') },
      h('div', { class: 'rl-file-card' },
        h('span', { class: 'rl-file-icon', 'data-ext': ext }, h(Icon, { name: 'file', size: 26 }), h('b', null, ext)),
        h('span', { class: 'rl-file-text' }, h('span', { class: 'rl-file-name' }, props.name), h('span', { class: 'rl-file-sub' }, props.meta)),
        props.state === 'loading'
          ? h(ProgressRing, { size: 36, progress: props.progress, onCancel: props.onCancel })
          : props.state === 'remote' ? h(IconButton, { icon: 'download', label: 'Скачать файл', filled: true, onClick: props.onDownload }) : null),
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
function MediaViewer(props) {
  var idx = useState(props.index || 0);
  var i = idx[0], items = props.items || [];
  var it = items[i] || {};
  useEffect(function () { return beginHeavyAnimation(320); }, [i]);
  if (props.open === false) return null;
  function go(d) { idx[1](function (x) { return Math.min(items.length - 1, Math.max(0, x + d)); }); }
  function onKey(e) {
    if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'Escape' && props.onClose) props.onClose();
  }
  return h('div', { class: 'rl-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Просмотр медиа', tabIndex: -1, onKeyDown: onKey, ref: function (el) { if (el && document.activeElement === document.body) el.focus(); } },
    h('div', { class: 'rl-viewer-top' },
      h(Avatar, { name: props.sender, size: 40 }),
      h('div', { class: 'rl-viewer-who' }, h('b', null, props.sender), h('span', null, it.date || props.date)),
      h(IconButton, { icon: 'zoomIn', label: 'Увеличить' }),
      h(IconButton, { icon: 'star', label: 'В избранное' }),
      h(IconButton, { icon: 'reply', label: 'Ответить' }),
      h(IconButton, { icon: 'download', label: 'Скачать' }),
      h(IconButton, { icon: 'close', label: 'Закрыть', onClick: props.onClose })),
    h('div', { class: 'rl-viewer-stage' },
      h(IconButton, { icon: 'chevronLeft', label: 'Предыдущее', filled: true, class: 'rl-viewer-nav', disabled: i === 0, onClick: function () { go(-1); } }),
      h('figure', { key: i, class: 'rl-viewer-media' },
        h(MediaArt, { seed: it.seed }),
        it.kind === 'video' ? h('span', { class: 'rl-media-center' }, h('span', { class: 'rl-media-play rl-media-play-lg' }, h(Icon, { name: 'play', size: 34 }))) : null,
        it.caption ? h('figcaption', null, it.caption) : null),
      h(IconButton, { icon: 'chevronRight', label: 'Следующее', filled: true, class: 'rl-viewer-nav', disabled: i === items.length - 1, onClick: function () { go(1); } })),
    h('div', { class: 'rl-viewer-strip' }, items.map(function (x, k) {
      return h(MediaThumb, { key: k, seed: x.seed, kind: x.kind, size: 56, selected: k === i, onClick: function () { idx[1](k); } });
    })));
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
  return h('div', { class: 'rl-panel-head' },
    h(IconButton, { icon: props.icon || 'close', label: props.closeLabel || 'Закрыть', onClick: props.onClose }),
    h('h2', null, props.title),
    props.action ? h(IconButton, { icon: props.action.icon, label: props.action.label, onClick: props.action.onClick }) : null);
}
function ProfileHeader(props) {
  return h('div', { class: 'rl-profile' },
    h(Avatar, { name: props.name, src: props.src, size: props.size || 120 }),
    h('div', { class: 'rl-profile-name' }, props.name),
    h('div', { class: 'rl-profile-sub' }, props.subtitle, props.accent ? [' · ', h('b', { key: 'a' }, props.accent)] : null),
    props.actions ? h('div', { class: 'rl-profile-actions' }, props.actions) : null);
}
function ActionTile(props) {
  return h('button', { type: 'button', class: 'rl-tile', onPointerDown: ripple, onClick: props.onClick },
    h('span', { class: 'rl-tile-icon' }, h(Icon, { name: props.icon, size: 24 })), h('span', null, props.label));
}
function InfoRow(props) {
  var Tag = props.trailing && props.trailing.type === Switch ? 'div' : 'button';
  return h(Tag, { type: Tag === 'button' ? 'button' : undefined, class: cx('rl-inforow', props.danger && 'rl-inforow-danger'), onPointerDown: Tag === 'button' ? ripple : undefined, onClick: props.onClick },
    h('span', { class: 'rl-inforow-icon' }, h(Icon, { name: props.icon, size: 24 })),
    h('span', { class: 'rl-inforow-text' }, h('span', null, props.title), props.subtitle ? h('small', null, props.subtitle) : null),
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
  useLayoutEffect(function () {
    var el = ref.current;
    if (!el) return;
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
  });
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
  var art = kind === 'search'
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
    h('button', { type: 'button', class: 'rl-fab', onPointerDown: ripple, onClick: props.onClick, 'aria-label': 'К последним сообщениям' },
      h(Icon, { name: 'chevronDown', size: 22 }),
      props.unread ? h(Badge, { count: props.unread }) : null));
}


export { ArchivedRow, ReplyQuote, ReactionChips, cx, chain, ripple, reducedMotion, omit, fmtTime, makeWave, ICONS, Icon, Button, IconButton, Avatar, Badge, Chip, SearchField, ChatRow, ChatRowSkeleton, Bubble, MessageStatus, TypingIndicator, DateDivider, Composer, Banner, Modal, NavRail, Checkbox, Toast, Card, Steps, MediaArt, ProgressRing, Waveform, VoiceMessage, VoiceRecorder, MediaBubble, FileBubble, MediaThumb, MediaViewer, Switch, PanelHeader, ProfileHeader, ActionTile, InfoRow, ReadMore, Presence, useMinVisible, FlipList, SyncIndicator, LinearProgress, EmptyState, ScrollToBottom };
