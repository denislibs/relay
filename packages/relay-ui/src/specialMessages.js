// Особые сообщения — по поведению Telegram, своя реализация и своя графика:
//  • ContactMessage — аватар, имя, «Контакт Relay»; кнопка «Написать» открывает чат с ним;
//  • GeoMessage — карта из тайлов (через свой сервер) с булавкой; место — название и адрес под картой;
//    без тайлов (нет сети, источник недоступен) — клетчатая подложка, булавка и координаты остаются;
//  • DiceMessage — без пузыря, как стикер: 🎲 — своя грань с точками (бросок кувырком), остальные — крупный
//    эмодзи и подпись результата; у неотправленного значения ещё нет — кубик крутится, пока не придёт.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { cx, Avatar, MsgLine, ForwardTitle, ReplyQuote, ReactionChips, MessageStatus, metaOrReactions } from './kit.js';

/** Тайл XYZ и смещение точки в нём (256×256) — та же формула, что geoTile в протоколе (кит от протокола не зависит). */
function geoTile(lat, lng, zoom) {
  var n = Math.pow(2, zoom), rad = lat * Math.PI / 180;
  var fx = (lng + 180) / 360 * n, fy = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n;
  var x = Math.floor(fx), y = Math.floor(fy);
  return { x: x, y: y, px: Math.round((fx - x) * 256), py: Math.round((fy - y) * 256) };
}

function Meta(props, out) {
  return h('span', { class: 'rl-bubble-meta' }, props.metaBefore ? props.metaBefore() : null, props.time, out || props.status ? h(MessageStatus, { status: props.status || 'sent' }) : null);
}
function bubbleClass(props, out, extra) {
  return cx('rl-bubble', extra, out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && 'rl-bubble-tail', props.metaBefore && 'rl-meta-flow', props.footer && 'rl-bubble-has-footer', props.reactions && props.reactions.length && 'rl-bubble-has-react', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in'));
}
function Head(props) {
  return [
    props.fwd ? h(ForwardTitle, { key: 'f', fwd: props.fwd }) : null,
    props.author && !props.fwd ? h('span', { key: 'a', class: 'rl-bubble-author', style: { color: 'var(--peer-' + (props.authorTone != null ? props.authorTone : 5) + ')' } }, props.author) : null,
    props.reply ? h(ReplyQuote, Object.assign({ key: 'r', inBubble: true }, props.reply)) : null,
  ];
}

/* ---------- контакт ---------- */
/** props: contact { userId, name }, avatar (свойства Avatar), tone, canWrite, onWrite(), onOpen() + общие пузыря. */
export function ContactMessage(props) {
  var c = props.contact, out = props.from === 'out';
  return h(MsgLine, { aside: props.aside, class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: bubbleClass(props, out, 'rl-contactm') },
      Head(props),
      h('button', { type: 'button', class: 'rl-contactm-card', onClick: props.onOpen ? function (e) { e.stopPropagation(); props.onOpen(); } : undefined, disabled: !props.onOpen },
        h(Avatar, Object.assign({ name: c.name, tone: props.tone, size: 48 }, props.avatar)),
        h('span', { class: 'rl-contactm-text' }, h('b', null, c.name), h('small', null, c.phone || 'Контакт Relay'))),
      metaOrReactions(props, out, Meta(props, out)),
      props.canWrite ? h('button', { type: 'button', class: 'rl-contactm-write', onClick: function (e) { e.stopPropagation(); props.onWrite(); } }, 'Написать') : null,
      props.footer ? h('div', { class: 'rl-bubble-footer' }, props.footer) : null));
}

/* ---------- геопозиция ---------- */
var MAP_W = 300, MAP_H = 200, MAP_Z = 15;

/** Булавка — своя: капля с белой точкой и тенью у острия. */
function Pin() {
  return h('svg', { class: 'rl-geom-pin', viewBox: '0 0 32 44', width: 32, height: 44, 'aria-hidden': 'true' },
    h('ellipse', { cx: 16, cy: 41, rx: 6, ry: 2.5, fill: 'rgba(0,0,0,.25)' }),
    h('path', { d: 'M16 2C8.8 2 3 7.7 3 14.8 3 24.6 16 40 16 40s13-15.4 13-25.2C29 7.7 23.2 2 16 2z', fill: 'var(--brand-strong, var(--brand))', stroke: '#fff', 'stroke-width': 2 }),
    h('circle', { cx: 16, cy: 15, r: 5, fill: '#fff' }));
}

/** Карта с булавкой по центру: 3×3 тайла вокруг точки (лишние, что не попадают в рамку, не грузим).
 *  props: geo, tileUrl(z, x, y), w, h, label, onClick, children (поверх: плашка времени). */
export function GeoMap(props) {
  var g = props.geo, W = props.w || MAP_W, H = props.h || MAP_H;
  var t = geoTile(g.lat, g.lng, MAP_Z), n = Math.pow(2, MAP_Z);
  var broken = useState(0);
  var tiles = [];
  for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
    var left = W / 2 - t.px + dx * 256, top = H / 2 - t.py + dy * 256;
    if (left >= W || top >= H || left + 256 <= 0 || top + 256 <= 0) continue;
    var x = ((t.x + dx) % n + n) % n, y = t.y + dy;
    if (y < 0 || y >= n) continue;
    tiles.push(h('img', { key: dx + ':' + dy, class: 'rl-geom-tile', src: props.tileUrl(MAP_Z, x, y), alt: '', draggable: false, decoding: 'async', loading: 'lazy',
      style: { left: left + 'px', top: top + 'px' }, onError: function (e) { e.currentTarget.style.visibility = 'hidden'; broken[1](function (k) { return k + 1; }); } }));
  }
  var coords = g.lat.toFixed(5) + ', ' + g.lng.toFixed(5);
  return h(props.onClick ? 'button' : 'div', { type: props.onClick ? 'button' : undefined, class: 'rl-geom-map', style: { width: W + 'px', height: H + 'px' }, 'aria-label': props.label || coords,
    onClick: props.onClick ? function (e) { e.stopPropagation(); props.onClick(); } : undefined },
    tiles,
    broken[0] ? h('span', { class: 'rl-geom-coords' }, coords) : null,
    h(Pin),
    props.children);
}

/** props: geo { lat, lng, title?, address? }, tileUrl(z, x, y) → адрес, onOpen() + общие пузыря. */
export function GeoMessage(props) {
  var g = props.geo, out = props.from === 'out', venue = !!g.title;
  var coords = g.lat.toFixed(5) + ', ' + g.lng.toFixed(5);
  return h(MsgLine, { aside: props.aside, class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: bubbleClass(props, out, cx('rl-geom', !venue && 'rl-geom-bare')) },
      Head(props),
      h(GeoMap, { geo: g, tileUrl: props.tileUrl, label: (venue ? g.title + ', ' : '') + 'открыть на карте: ' + coords, onClick: props.onOpen },
        !venue ? h('span', { class: 'rl-media-chip rl-geom-meta' }, props.metaBefore ? props.metaBefore() : null, props.time, out || props.status ? h(MessageStatus, { status: props.status || 'sent' }) : null) : null),
      venue ? h('div', { class: 'rl-geom-venue' }, h('b', null, g.title), g.address ? h('small', null, g.address) : null) : null,
      venue ? metaOrReactions(props, out, Meta(props, out)) : (props.reactions && props.reactions.length ? h(ReactionChips, { items: props.reactions, out: out, onClick: props.onReact }) : null),
      props.footer ? h('div', { class: 'rl-bubble-footer' }, props.footer) : null));
}

/* ---------- кубики ---------- */
var PIPS = { 1: [[50, 50]], 2: [[28, 28], [72, 72]], 3: [[28, 28], [50, 50], [72, 72]], 4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]], 6: [[28, 26], [72, 26], [28, 50], [72, 50], [28, 74], [72, 74]] };

/** Грань кубика — своя отрисовка: скруглённый квадрат с объёмом и точками. value 0 — точек нет (ещё летит). */
function DieFace(props) {
  return h('svg', { class: 'rl-dice-die', viewBox: '0 0 100 100', width: props.size, height: props.size, 'aria-hidden': 'true' },
    h('rect', { x: 6, y: 8, width: 88, height: 88, rx: 20, fill: 'rgba(0,0,0,.18)' }),
    h('rect', { x: 4, y: 4, width: 88, height: 88, rx: 20, fill: '#fff', stroke: 'rgba(0,0,0,.12)', 'stroke-width': 2 }),
    (PIPS[props.value] || []).map(function (p, i) { return h('circle', { key: i, cx: p[0] - 2, cy: p[1] - 2, r: 8.5, fill: props.value === 1 ? '#e53935' : '#1f2328' }); }));
}

var SLOT = ['BAR', '🍇', '🍋', '7'];
/** Барабаны слотов по значению (1..64): три символа из четырёх, 64 — три семёрки (как кодирует Telegram). */
export function slotReels(value) {
  var v = value - 1;
  return [SLOT[v % 4], SLOT[(v >> 2) % 4], SLOT[(v >> 4) % 4]];
}
/** Слоты — свои барабаны, а не системный 🎰 (на нём нарисованы «777», что бы ни выпало). */
function Slots(props) {
  var reels = props.value ? slotReels(props.value) : ['?', '?', '?'];
  return h('span', { class: cx('rl-slots', props.value === 64 && 'rl-slots-win'), 'aria-hidden': 'true' },
    reels.map(function (r, i) {
      return h('span', { key: i, class: cx('rl-slots-reel', r === 'BAR' && 'rl-slots-bar', r === '7' && 'rl-slots-seven'), style: { animationDelay: (i * 120) + 'ms' } }, r);
    }));
}
/** Итог броска словами (как подписи результата в Telegram); у кубика — само число. */
export function diceResult(d) {
  if (!d || !d.value) return '';
  switch (d.emoji) {
    case '🎲': return String(d.value);
    case '🎯': return d.value === 6 ? 'В яблочко!' : d.value === 1 ? 'Мимо' : 'Попадание';
    case '🏀': return d.value >= 4 ? 'Попал!' : 'Мимо';
    case '⚽': return d.value >= 3 ? 'Гол!' : 'Мимо';
    case '🎳': return d.value === 6 ? 'Страйк!' : d.value === 1 ? 'Мимо' : 'Сбито кеглей: ' + Math.min(5, d.value - 1);
    case '🎰': {
      return d.value === 64 ? 'Джекпот!' : slotReels(d.value).join(' · ');
    }
    default: return '';
  }
}

/** props: dice { emoji, value }, roll (бросок на глазах — анимировать), onClick + общие (время, статус, ответ, реакции). */
export function DiceMessage(props) {
  var d = props.dice, out = props.from === 'out', pending = !d.value;
  var head = props.fwd || props.author || props.reply;
  var label = (d.emoji === '🎲' ? 'Кубик' : 'Бросок ' + d.emoji) + (pending ? '' : ': ' + diceResult(d));
  return h(MsgLine, { aside: props.aside, class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-sticker-msg', out ? 'rl-sticker-msg-out' : 'rl-sticker-msg-in', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in')) },
      head ? h('div', { class: cx('rl-sticker-head', out && 'rl-sticker-head-out') }, Head(props)) : null,
      h('div', { class: 'rl-sticker-box' },
        h('button', { type: 'button', class: cx('rl-dice', (props.roll || pending) && 'rl-dice-roll', pending && 'rl-dice-pending'), 'aria-label': label, onClick: props.onClick ? function (e) { e.stopPropagation(); props.onClick(); } : undefined },
          d.emoji === '🎲' ? h(DieFace, { size: 120, value: pending ? 0 : d.value }) : d.emoji === '🎰' ? h(Slots, { value: pending ? 0 : d.value }) : h('span', { class: 'rl-dice-emoji' }, d.emoji),
          d.emoji !== '🎲' && !pending && (d.emoji !== '🎰' || d.value === 64) ? h('span', { class: 'rl-dice-result' }, diceResult(d)) : null),
        h('span', { class: 'rl-media-chip rl-sticker-meta' }, props.metaBefore ? props.metaBefore() : null, props.time, out || props.status ? h(MessageStatus, { status: props.status || 'read' }) : null)),
      props.reactions && props.reactions.length ? h(ReactionChips, { items: props.reactions, out: out, float: true, onClick: props.onReact }) : null));
}
