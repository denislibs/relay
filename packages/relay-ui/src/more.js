import { h } from 'preact';
import { createPortal } from 'preact/compat';
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { requestMeasure, requestMutation, onHeavyAnimationEnd, beginHeavyAnimation, forceMeasure } from './schedule.js';
import { TWallpaper } from 'twallpaper';
import { cx, ripple, reducedMotion, Presence, Icon, IconButton, Avatar, Badge, Button, Checkbox, MediaArt, MessageStatus, SearchField, ICONS } from './kit.js';

/* Relay UI kit — components added in the Preact version. */

/* ---------- Menu: popover list (message menu, chat context menu, header menu) ---------- */
function Menu(props) {
  // Подменю — как в Telegram: отдельная карточка сбоку от пункта (основное меню остаётся), по наведению, клику или →.
  var ref = useRef(null), timer = useRef(0);
  var sub = useState(null), open = sub[0];   // { index, top } пункта с подменю
  var items = props.items || [];
  useEffect(function () {
    var first = ref.current && ref.current.querySelector(':scope > [role="menuitem"]');
    if (first && !props.noFocus) first.focus({ preventScroll: true });
    return function () { clearTimeout(timer.current); };
  }, []);
  function openSub(i, el, now) {
    clearTimeout(timer.current);
    var go = function () { var r = el.getBoundingClientRect(); sub[1]({ index: i, left: r.right - 24, top: r.top - 4 }); };
    if (now) go(); else timer.current = setTimeout(go, 120);
  }
  function closeSub(now) {
    clearTimeout(timer.current);
    if (now) sub[1](null); else timer.current = setTimeout(function () { sub[1](null); }, 200);
  }
  function onKey(e) {
    if (!ref.current.contains(e.target)) return;   // клавиши из подменю (портал всплывает сюда через дерево) — его дело
    var list = Array.prototype.slice.call(ref.current.querySelectorAll(':scope > [role^="menuitem"]'));
    var i = list.indexOf(document.activeElement);
    var di = document.activeElement && document.activeElement.dataset ? Number(document.activeElement.dataset.i) : NaN;
    var it = isNaN(di) ? null : items[di];
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'ArrowRight' && it && it.submenu) { e.preventDefault(); openSub(di, document.activeElement, true); }
    else if (e.key === 'ArrowLeft' && props.onBack) { e.preventDefault(); e.stopPropagation(); props.onBack(); }
    else if (e.key === 'Escape') { if (props.onClose) props.onClose(); }
  }
  var style = props.x !== undefined ? { left: props.x, top: props.y } : null;
  var opened = open && items[open.index];
  return h('div', { ref: ref, class: cx('rl-menu', props.origin && 'rl-menu-' + props.origin, props.class), style: style, role: 'menu', 'aria-label': props.label || 'Меню', onKeyDown: onKey },
    props.header || null,
    items.map(function (it, i) {
      if (it === '-') return h('hr', { key: 'sep' + i, class: 'rl-menu-sep' });
      var toggle = typeof it.checked === 'boolean';
      return h('button', { key: it.label, type: 'button', 'data-i': i, role: toggle ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': toggle ? String(it.checked) : undefined,
        'aria-haspopup': it.submenu ? 'menu' : undefined, 'aria-expanded': it.submenu ? String(!!(open && open.index === i)) : undefined,
        class: cx('rl-menu-item', it.danger && 'rl-menu-danger', open && open.index === i && 'rl-menu-item-open'),
        onPointerEnter: function (e) { if (it.submenu) openSub(i, e.currentTarget); else if (open) closeSub(); },
        onPointerLeave: function () { if (it.submenu) closeSub(); },
        onClick: function (e) {
          if (it.submenu) { if (open && open.index === i) closeSub(true); else openSub(i, e.currentTarget, true); return; }
          if (it.onClick) it.onClick();
          if (!it.keepOpen && props.onClose) props.onClose();
        } },
        it.icon ? h(Icon, { name: it.icon, size: 20 }) : null, h('span', null, it.label),
        toggle ? h('i', { class: cx('rl-menu-switch', it.checked && 'rl-menu-switch-on'), 'aria-hidden': 'true' }) : null,
        it.submenu ? h(Icon, { name: 'chevronRight', size: 18 }) : null,
        it.hint ? h('kbd', null, it.hint) : null);
    }),
    // подменю — порталом в body с координатами пункта: панель вокруг меню его не обрежет
    opened ? createPortal(h('div', { class: 'rl rl-submenu', style: { left: Math.min(open.left, window.innerWidth - 260) + 'px', top: open.top + 'px' },
      onPointerEnter: function () { clearTimeout(timer.current); }, onPointerLeave: function () { closeSub(); } },
      h(Menu, { items: opened.submenu, label: opened.label, noFocus: true, onClose: props.onClose,
        onBack: function () { closeSub(true); var b = ref.current && ref.current.querySelector('.rl-menu-item-open'); if (b) b.focus(); } })), document.body) : null);
}

/* ---------- ReactionPicker: quick reactions row (emoji are content, not UI icons) ---------- */
var QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
function ReactionPicker(props) {
  var list = props.emoji || QUICK;
  return h('div', { class: 'rl-rpick', role: 'toolbar', 'aria-label': 'Реакции' },
    list.map(function (e, i) {
      return h('button', { key: e, type: 'button', class: cx('rl-rpick-btn', props.selected === e && 'rl-rpick-on'), style: { '--i': i }, 'aria-label': 'Реакция ' + e, 'aria-pressed': String(props.selected === e),
        onClick: function () { if (props.onPick) props.onPick(e); } }, e);
    }),
    h('button', { type: 'button', class: 'rl-rpick-btn rl-rpick-more', style: { '--i': list.length }, 'aria-label': 'Другие реакции', onClick: props.onMore }, h(Icon, { name: 'plus', size: 18 })));
}

/* ---------- AttachMenu: what to attach, items pop in one after another ---------- */
// только то, что работает (как в Telegram: сначала медиа, потом файл); остальное приложение передаёт само через items
var ATTACH = [
  { key: 'media', icon: 'image', label: 'Фото или видео' },
  { key: 'doc', icon: 'file', label: 'Файл' }
];
function AttachMenu(props) {
  return h('div', { class: 'rl-attach', role: 'menu', 'aria-label': 'Прикрепить', onMouseEnter: props.onMouseEnter, onMouseLeave: props.onMouseLeave },
    (props.items || ATTACH).map(function (it) {
      return h('button', { key: it.key, type: 'button', role: 'menuitem', class: 'rl-attach-item', onPointerDown: ripple, onClick: function () { if (props.onPick) props.onPick(it.key); } },
        h('span', { class: 'rl-attach-icon' }, h(Icon, { name: it.icon, size: 22 })), it.label);
    }));
}

/* ---------- MentionList: @-autocomplete above the composer ---------- */
function MentionList(props) {
  return h('div', { class: 'rl-mentions', role: 'listbox', 'aria-label': 'Участники' },
    props.items.map(function (x, i) {
      return h('button', { key: x.name, type: 'button', role: 'option', 'aria-selected': String(i === 0), class: cx('rl-mention', i === 0 && 'rl-mention-active'), onPointerDown: function (e) { e.preventDefault(); }, onClick: function () { props.onPick(x); } },
        h(Avatar, { name: x.name, size: 32 }), h('span', null, h('b', null, x.name), x.sub ? h('small', null, x.sub) : null));
    }));
}

/* ---------- DropOverlay: drag files over the chat ---------- */
function DropOverlay(props) {
  return h('div', { class: 'rl-drop', 'aria-hidden': 'true' },
    h('div', { class: 'rl-drop-box' },
      h('svg', { class: 'rl-drop-art', width: 72, height: 72, viewBox: '0 0 72 72', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
        h('rect', { class: 'rl-drop-page rl-drop-page-1', x: 14, y: 16, width: 30, height: 38, rx: 4 }),
        h('rect', { class: 'rl-drop-page rl-drop-page-2', x: 26, y: 10, width: 30, height: 38, rx: 4 }),
        h('path', { class: 'rl-drop-arrow', d: 'M41 54V36M34 43l7-7 7 7' })),
      h('b', null, props.title || 'Перетащите файлы сюда'),
      h('span', null, props.text || 'Фото, видео и документы до 2 ГБ')));
}

/* ---------- LinkPreview: card inside a bubble ---------- */
function LinkPreview(props) {
  return h('a', { class: 'rl-link-card', href: props.url, target: '_blank', rel: 'noopener noreferrer' },
    props.seed !== undefined ? h('span', { class: 'rl-link-thumb' }, h(MediaArt, { seed: props.seed })) : null,
    h('span', { class: 'rl-link-body' },
      h('b', null, props.title),
      props.description ? h('span', null, props.description) : null,
      h('small', null, props.domain)));
}

/* ---------- PollBubble ---------- */
function PollBubble(props) {
  var out = props.from === 'out';
  var st = useState(props.voted || null);
  var options = props.options || [];
  var total = options.reduce(function (n, o) { return n + o.votes; }, 0) + (st[0] !== null && st[0] !== props.voted ? 1 : 0);
  return h('div', { class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-bubble rl-poll', out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && 'rl-bubble-tail') },
      props.author ? h('span', { class: 'rl-bubble-author', style: { color: 'var(--author-' + (props.authorTone || 1) + ')' } }, props.author) : null,
      h('b', { class: 'rl-poll-q' }, props.question),
      h('small', { class: 'rl-poll-hint' }, h(Icon, { name: 'poll', size: 14 }), 'Выберите один вариант'),
      h('div', { class: 'rl-poll-opts', role: 'radiogroup', 'aria-label': props.question },
        options.map(function (o, i) {
          var votes = o.votes + (st[0] === i && props.voted !== i ? 1 : 0) - (props.voted === i && st[0] !== i ? 1 : 0);
          var pct = total ? votes / total : 0;
          return h('button', { key: i, type: 'button', role: 'radio', 'aria-checked': String(st[0] === i), class: cx('rl-poll-opt', st[0] === i && 'rl-poll-opt-on'), onClick: function () { st[1](i); if (props.onVote) props.onVote(i); } },
            h('span', { class: 'rl-poll-radio' }, h(Icon, { name: 'check', size: 14, strokeWidth: 3 })),
            h('span', { class: 'rl-poll-main' },
              h('span', { class: 'rl-poll-row' }, h('span', null, o.text), h('span', { class: 'rl-poll-count' }, votes)),
              h('span', { class: 'rl-poll-bar' }, h('i', { style: { transform: 'scaleX(' + (st[0] === null ? 0 : pct) + ')' } }))));
        })),
      h('div', { class: 'rl-poll-foot' }, h('span', { class: 'rl-bubble-meta rl-voice-meta' }, props.time, out ? h(MessageStatus, { status: props.status || 'read' }) : null)),
      h('button', { type: 'button', class: 'rl-poll-votes' }, 'Посмотреть голоса')));
}

/* ---------- UnreadDivider ---------- */
function UnreadDivider(props) {
  return h('div', { class: 'rl-unread', role: 'separator' }, h('span', null, props.count + ' ' + plural(props.count, 'непрочитанное сообщение', 'непрочитанных сообщения', 'непрочитанных сообщений')));
}
function plural(n, one, few, many) {
  var m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/* ---------- SelectionBar: multi-select actions (replaces the composer) ---------- */
function SelectionBar(props) {
  var n = props.count || 0;
  return h('div', { class: 'rl-selbar', role: 'toolbar', 'aria-label': 'Действия с выбранными' },
    h(IconButton, { icon: 'close', label: 'Отменить выбор', onClick: props.onCancel }),
    h('span', { class: 'rl-selbar-count', key: n }, 'Выбрано: ' + n),
    h(IconButton, { icon: 'star', label: 'В избранное', disabled: !n, onClick: props.onStar }),
    h(IconButton, { icon: 'copy', label: 'Копировать', disabled: !n, onClick: props.onCopy }),
    h(IconButton, { icon: 'forward', label: 'Переслать', disabled: !n, onClick: props.onForward }),
    h(IconButton, { icon: 'trash', label: 'Удалить', disabled: !n, onClick: props.onDelete }));
}

/* ---------- ChatSearchBar + Highlight ---------- */
function ChatSearchBar(props) {
  var total = props.total || 0;
  // busy: идёт поиск — лупа сменяется лоадером (тот же, что в поиске сайдбара)
  return h('div', { class: cx('rl-csearch', props.busy && 'rl-search-busy'), role: 'search' },
    h('span', { class: 'rl-search-icon rl-csearch-icon', 'aria-hidden': 'true' },
      h(Icon, { name: 'search', size: 22 }),
      h('svg', { class: 'rl-search-spin', width: 22, height: 22, viewBox: '0 0 18 18', fill: 'none' },
        h('circle', { cx: 9, cy: 9, r: 7, stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-dasharray': '30 44' }))),
    h('label', { for: props.id || 'rl-csearch', class: 'rl-sr' }, 'Поиск по чату'),
    h('input', { id: props.id || 'rl-csearch', type: 'search', placeholder: 'Поиск', value: props.value, autocomplete: 'off', autoFocus: true,
      onInput: function (e) { if (props.onQuery) props.onQuery(e.target.value); },
      onFocus: props.onFocus,
      onKeyDown: function (e) {
        if (e.key === 'Enter') { e.preventDefault(); var f = e.shiftKey ? props.onPrev : props.onNext; if (f) f(); }
        else if (e.key === 'Escape' && props.onClose) { e.preventDefault(); props.onClose(); }
      } }),
    h(IconButton, { icon: 'chevronUp', label: 'Предыдущее', disabled: !total, onClick: props.onNext }),
    h(IconButton, { icon: 'chevronDown', label: 'Следующее', disabled: !total, onClick: props.onPrev }),
    h(IconButton, { icon: 'close', label: 'Закрыть поиск', onClick: props.onClose }));
}
function Highlight(props) {
  var q = (props.query || '').trim();
  if (!q) return props.text;
  var parts = [], text = props.text, low = text.toLowerCase(), lq = q.toLowerCase(), at = 0, i;
  while ((i = low.indexOf(lq, at)) >= 0) { parts.push(text.slice(at, i)); parts.push(h('mark', { key: i, class: cx('rl-mark', props.current && 'rl-mark-current') }, text.slice(i, i + q.length))); at = i + q.length; }
  parts.push(text.slice(at));
  return parts;
}

/* ---------- ContactPicker: new chat / new group / people for a privacy exception ----------
   Ключ человека — c.id (если задан), иначе имя; selected и onChange — массивы ключей. empty — текст, когда искать не в ком. */
function ContactPicker(props) {
  var q = useState(''), sel = useState(props.selected || []);
  var multi = !!props.multi;
  var all = props.contacts || [];
  var keyOf = function (c) { return c.id != null ? c.id : c.name; };
  var byKey = {};
  all.forEach(function (c) { byKey[keyOf(c)] = c; });
  var needle = q[0].trim().toLowerCase();
  var list = all.filter(function (c) { return c.name.toLowerCase().indexOf(needle) >= 0 || (c.about && String(c.about).toLowerCase().indexOf(needle) >= 0); });
  function toggle(k) {
    if (!multi) { if (props.onPick) props.onPick(byKey[k] || { name: k }); return; }
    var has = sel[0].indexOf(k) >= 0;
    var next = has ? sel[0].filter(function (n) { return n !== k; }) : sel[0].concat([k]);
    sel[1](next); if (props.onChange) props.onChange(next);
  }
  return h('div', { class: 'rl-picker' },
    multi && sel[0].length ? h('div', { class: 'rl-picker-chips' }, sel[0].map(function (k) {
      var name = byKey[k] ? byKey[k].name : String(k);
      return h('button', { key: k, type: 'button', class: 'rl-picker-chip', onClick: function () { toggle(k); }, 'aria-label': 'Убрать ' + name },
        h(Avatar, { name: name, tone: byKey[k] ? byKey[k].tone : undefined, size: 24 }), name, h(Icon, { name: 'close', size: 14 }));
    })) : null,
    h('div', { class: 'rl-search rl-picker-search' },
      h('label', { for: 'rl-picker-q', class: 'rl-sr' }, props.searchLabel || 'Поиск контактов'),
      h(Icon, { name: 'search', size: 18 }),
      h('input', { id: 'rl-picker-q', type: 'search', placeholder: props.placeholder || 'Имя или номер', autocomplete: 'off', value: q[0], onInput: function (e) { q[1](e.target.value); } })),
    h('div', { class: 'rl-picker-list', role: multi ? 'group' : 'list' },
      list.length ? list.map(function (c) {
        var k = keyOf(c), on = sel[0].indexOf(k) >= 0;
        return h('button', { key: k, type: 'button', class: cx('rl-row rl-picker-row', on && 'rl-picker-on'), onPointerDown: ripple, onClick: function () { toggle(k); }, role: multi ? 'checkbox' : undefined, 'aria-checked': multi ? String(on) : undefined },
          h(Avatar, { name: c.name, tone: c.tone, online: c.online }),
          h('span', { class: 'rl-row-main' }, h('span', { class: 'rl-row-name' }, c.name), h('span', { class: 'rl-row-preview' }, c.about || '')),
          multi ? h('span', { class: 'rl-picker-check', 'aria-hidden': 'true' }, h(Icon, { name: 'check', size: 14, strokeWidth: 3 })) : null);
      }) : h('div', { class: 'rl-picker-empty' }, needle || !props.empty ? 'Никого не нашли по запросу «' + q[0] + '»' : props.empty)));
}

/* ---------- CallRow ---------- */
function CallRow(props) {
  var missed = props.kind === 'missed';
  return h('div', { class: 'rl-row rl-callrow' },
    h(Avatar, { name: props.name }),
    h('span', { class: 'rl-row-main' },
      h('span', { class: cx('rl-row-name', missed && 'rl-call-missed') }, props.name),
      h('span', { class: cx('rl-row-preview rl-call-meta', missed && 'rl-call-missed') },
        h(Icon, { name: props.kind === 'out' ? 'phoneOut' : 'phoneIn', size: 15 }), props.when)),
    h(IconButton, { icon: props.video ? 'video' : 'phone', label: props.video ? 'Видеозвонок' : 'Позвонить', onClick: props.onCall }));
}

/* ---------- StatusAvatar: avatar with a segmented story ring (seen segments dim) ---------- */
function StatusAvatar(props) {
  var size = props.size || 52, n = Math.max(1, props.count || 1), seen = props.seen || 0;
  var r = size / 2 - 2, c = 2 * Math.PI * r, gap = n > 1 ? 4 : 0, seg = c / n - gap;
  var arcs = [];
  for (var i = 0; i < n; i++) arcs.push(h('circle', { key: i, class: cx('rl-story-seg', i < seen && 'rl-story-seen'), cx: size / 2, cy: size / 2, r: r, style: { strokeDasharray: seg + ' ' + (c - seg), strokeDashoffset: -i * (seg + gap), '--d': (i * 60) + 'ms' } }));
  return h('span', { class: 'rl-story', style: { width: size, height: size }, role: 'img', 'aria-label': props.name + ': ' + (n - seen) + ' новых статусов' },
    h('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, 'aria-hidden': 'true' }, arcs),
    h(Avatar, { name: props.name, size: size - 10 }));
}

/* ---------- LoginQR: sign-in screen block ---------- */
function LoginQR(props) {
  var st = useState(0);
  useEffect(function () { var t = setInterval(function () { st[1](function (x) { return x + 1; }); }, props.refreshMs || 20000); return function () { clearInterval(t); }; }, []);
  var cells = [], seed = st[0] * 7 + 3;
  for (var y = 0; y < 25; y++) for (var x = 0; x < 25; x++) {
    var inFinder = (x < 7 && y < 7) || (x > 17 && y < 7) || (x < 7 && y > 17);
    if (inFinder) continue;
    seed = (seed * 9301 + 49297) % 233280;
    if (seed / 233280 > 0.52) cells.push(h('rect', { key: x + '-' + y, x: x * 4, y: y * 4, width: 4, height: 4 }));
  }
  function finderMark(x, y) { return h('g', { key: 'f' + x + y }, h('rect', { x: x + 1, y: y + 1, width: 26, height: 26, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 3 }), h('rect', { x: x + 8, y: y + 8, width: 12, height: 12, rx: 2 })); }
  return h('div', { class: 'rl-login' },
    h('div', { class: 'rl-login-text' },
      h('h1', null, props.title || 'Отсканируйте, чтобы войти'),
      h('ol', { class: 'rl-steps' }, (props.steps || ['Откройте приложение на телефоне', 'Нажмите «Связанные устройства» → «Привязать»', 'Наведите камеру на этот код']).map(function (t, i) {
        return h('li', { key: i }, h('span', { class: 'rl-steps-num', 'aria-hidden': 'true' }, i + 1), h('span', null, t));
      })),
      props.footer || null),
    h('div', { class: 'rl-login-qr', key: st[0], role: 'img', 'aria-label': 'QR-код для входа, обновляется каждые 20 секунд' },
      h('svg', { viewBox: '0 0 100 100', width: 240, height: 240 }, h('g', { class: 'rl-qr-cells' }, cells), finderMark(0, 0), finderMark(72, 0), finderMark(0, 72)),
      h('span', { class: 'rl-qr-scan', 'aria-hidden': 'true' })));
}

/* ---------- VirtualList: windowed list with variable heights, measure → mutate ---------- */
/* ---------- WindowList: fixed-height rows virtualised inside the nearest scrolling ancestor ----------
   Only rows in view (+ overscan) are in the DOM. Rows are absolutely placed, so a reorder is a transform
   change that CSS animates; scrolling never touches transforms, so it never animates. */
function WindowList(props) {
  var items = props.items || [], rh = props.rowHeight || 72, over = props.overscan == null ? 6 : props.overscan;
  var host = useRef(null), range = useState([0, Math.min(items.length, 20)]);
  var n = items.length;
  var cur = useRef(range[0]); cur.current = range[0];
  var nearEnd = useRef(props.onNearEnd); nearEnd.current = props.onNearEnd;
  // окно (видимое + overscan) упёрлось в хвост — до конца меньше полуэкрана строк, пора подгружать следующую страницу
  useEffect(function () {
    if (nearEnd.current && n && range[0][1] >= n) nearEnd.current();
  }, [range[0][1], n]);
  useLayoutEffect(function () {
    var el = host.current, sc = null, queued = false, ro = null, alive = true;
    function measure() {
      queued = false;
      var offset = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop; // where the list starts in the scroller
      var top = sc.scrollTop - offset, bottom = top + sc.clientHeight;
      var vTop = Math.max(0, Math.floor(top / rh)), vBot = Math.ceil(bottom / rh);
      // запас с гистерезисом: окно сдвигаем, только когда до его края осталось меньше двух строк,
      // и сразу с полным запасом — иначе перерисовка всего списка на каждые 72 px прокрутки
      var r = cur.current, edge = Math.min(2, over);
      var covered = r[0] <= Math.max(0, vTop - edge) && r[1] >= vBot + edge;
      var next = [Math.max(0, vTop - over), vBot + over];
      if (covered && r[1] - r[0] <= next[1] - next[0] + over * 2) return;
      requestMutation(function () { range[1](function (r) { return r[0] === next[0] && r[1] === next[1] ? r : next; }); });
    }
    function onScroll() { if (!queued) { queued = true; requestMeasure(measure); } }
    // прокручиваемого родителя ищем в фазе замера: getComputedStyle — это чтение стилей
    requestMeasure(function () {
      if (!alive) return;
      sc = el.parentElement;
      while (sc && sc !== document.body && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
      if (!sc) return;
      sc.addEventListener('scroll', onScroll, { passive: true });
      ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onScroll) : null;
      if (ro) ro.observe(sc);
      queued = true; measure();
    });
    return function () { alive = false; if (sc) sc.removeEventListener('scroll', onScroll); if (ro) ro.disconnect(); };
  }, [rh, over]);
  // строки переставились (чат поднялся наверх) — пока они едут, это тяжёлая анимация.
  // Позиции известны без чтения DOM: индекс × высота строки
  var lastIndex = useRef(null);
  var nowIndex = {};
  for (var q = Math.min(range[0][0], n); q < Math.min(range[0][1], n); q++) nowIndex[props.getKey(items[q], q)] = q;
  useLayoutEffect(function () {
    var prev = lastIndex.current, moved = false;
    if (prev) for (var k in nowIndex) if (prev[k] !== undefined && prev[k] !== nowIndex[k]) { moved = true; break; }
    lastIndex.current = nowIndex;
    if (moved && !reducedMotion()) beginHeavyAnimation(320);
  });
  var first = Math.min(range[0][0], n), last = Math.min(range[0][1], n);
  var rows = [];
  for (var i = first; i < last; i++) {
    var key = props.getKey(items[i], i);
    // z: верхние строки поверх — строка, поднимающаяся наверх, едет над соседями, а не под ними
    rows.push({ key: key, el: h('div', { key: key, class: 'rl-wrow', style: { transform: 'translateY(' + i * rh + 'px)', height: rh, zIndex: n - i } }, props.render(items[i], i)) });
  }
  // DOM-порядок стабилен (по ключу), место — только transform: если Preact переставит узел в DOM,
  // CSS-переход у него сбросится и строка прыгнет вместо того, чтобы проехать
  rows.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  rows = rows.map(function (r) { return r.el; });
  return h('div', { ref: host, class: cx('rl-wlist', props.class), role: props.role, style: { height: n * rh } }, rows);
}

/* ---------- AsidePanel: right-hand floating card (user info, search…) that pushes the chat column ---------- */
/* Правая панель. Ширина колонки чата меняется один раз (раскладка — одна), а плавность даёт transform:
   панель въезжает/уезжает сдвигом (при уходе — вне потока), колонка чата FLIP-ом догоняет новый центр.
   Так каждый кадр анимации — только композиция, без перераскладки ленты. */
var ASIDE_MS = 280;
/* x центральной колонки чата (шапка по центру; нет шапки — сама колонка) */
function anchorX(aside) {
  var shell = aside ? aside.closest('.rl-shell') : document.querySelector('.rl-shell');
  var main = shell && shell.querySelector(':scope > .rl-shell-main');
  if (!main) return null;
  // стек чатов: шапка колонки на экране ([data-current]), остальные сдвинуты
  return forceMeasure(function () { return (main.querySelector('[data-current] .rl-glassbar') || main.querySelector('.rl-glassbar') || main).getBoundingClientRect().left; });
}
function AsidePanel(props) {
  var ref = useRef(null), was = useRef(!!props.open), before = useRef(null);
  // положение колонки до смены — замер в рендере, пока DOM ещё прежний (FLIP: First)
  if (!!props.open !== was.current) before.current = anchorX(ref.current);
  useLayoutEffect(function () {
    var open = !!props.open;
    if (was.current === open) return;
    was.current = open;
    var aside = ref.current, shell = aside && aside.closest('.rl-shell');
    var main = shell && shell.querySelector(':scope > .rl-shell-main');
    // узкий экран: панель поверх чата, колонка не меняется
    if (!main || reducedMotion() || matchMedia('(max-width: 1100px)').matches) return;
    var end = beginHeavyAnimation(ASIDE_MS + 20);
    var from = before.current, to = anchorX(aside);
    if (from == null || to == null || Math.abs(from - to) < 1) { end(); return; }
    forceMeasure(function () {
      main.style.transition = 'none';
      main.style.willChange = 'transform';
      main.style.transform = 'translateX(' + (from - to) + 'px)';
    });
    var raf = requestAnimationFrame(function () { requestMutation(function () {
      main.style.transition = 'transform ' + ASIDE_MS + 'ms cubic-bezier(0.2, 0, 0, 1)';
      main.style.transform = '';
    }); });
    var t = setTimeout(function () { requestMutation(function () { main.style.transition = ''; main.style.willChange = ''; }); end(); }, ASIDE_MS + 20);
    return function () { cancelAnimationFrame(raf); clearTimeout(t); end(); };
  }, [props.open]);
  return h(Presence, { show: !!props.open, exitMs: 260 },
    h('aside', { class: 'rl-shell-aside', ref: ref },
      h('section', { class: 'rl-panel rl-asidecard', 'aria-label': props.label || 'Панель' }, props.children)));
}

/* ---------- SideFrame: the floating sidebar card as a frame for SlideStack pages ---------- */
function SideFrame(props) {
  return h('section', { class: cx('rl-sidecard', props.class), 'aria-label': props.label || 'Боковая панель' }, props.children);
}

/* ---------- SlideStack: screens that slide like Telegram's sidebar ----------
   order: page keys from root to deepest. Going deeper slides the new page in from the right while the
   old one drifts left and dims; going back plays it in reverse. The root page stays mounted (hidden,
   not removed), so the chat list keeps its scroll position and virtual window. */
var SLIDE_MS = 300;
function SlideStack(props) {
  var order = props.order || [], active = props.active;
  var st = useState(null), anim = st[0]; // { from, to, dir: 1 push | -1 pop }
  var prev = useRef(active);
  useLayoutEffect(function () {
    if (prev.current === active) return;
    var from = prev.current;
    prev.current = active;
    if (reducedMotion()) { st[1](null); return; }
    var dir = order.indexOf(active) > order.indexOf(from) ? 1 : -1;
    st[1]({ from: from, to: active, dir: dir });
    var end = beginHeavyAnimation(SLIDE_MS);
    var t = setTimeout(function () { st[1](null); end(); }, SLIDE_MS);
    return function () { clearTimeout(t); end(); };
  }, [active]);
  var root = order[0];
  return h('div', { class: cx('rl-slides', props.variant === 'tabs' && 'rl-slides-tabs') }, order.map(function (key) {
    var isActive = key === active, leaving = anim && anim.from === key;
    if (!isActive && !leaving && key !== root) return null;
    var cls = 'rl-slide';
    if (anim && (isActive || leaving)) {
      var push = anim.dir > 0;
      cls += isActive ? (push ? ' rl-slide-in-push' : ' rl-slide-in-pop') : (push ? ' rl-slide-out-push' : ' rl-slide-out-pop');
    } else if (!isActive) cls += ' rl-slide-parked';
    return h('div', { key: key, class: cls, inert: !isActive || undefined, 'aria-hidden': !isActive || undefined }, props.render(key));
  }));
}

function VirtualList(props) {
  var items = props.items || [], est = props.estimate || 64, over = props.overscan || 6;
  var host = useRef(null), heights = useRef({}), st = useState({ top: 0, height: 600 });
  var offsets = [], acc = 0;
  for (var i = 0; i < items.length; i++) { offsets.push(acc); acc += heights.current[props.getKey(items[i], i)] || est; }
  var first = 0;
  while (first < items.length - 1 && offsets[first + 1] < st[0].top) first++;
  var last = first;
  while (last < items.length - 1 && offsets[last] < st[0].top + st[0].height) last++;
  first = Math.max(0, first - over); last = Math.min(items.length - 1, last + over);
  useLayoutEffect(function () {
    // measure every rendered row once, then re-render only if a height actually changed
    var el = host.current; if (!el) return;
    var changed = false;
    Array.prototype.forEach.call(el.querySelectorAll('[data-vkey]'), function (n) {
      var k = n.getAttribute('data-vkey'), hgt = n.offsetHeight;
      if (heights.current[k] !== hgt) { heights.current[k] = hgt; changed = true; }
    });
    if (!changed) return;
    // a height changed: re-layout, but never in the middle of a heavy animation
    onHeavyAnimationEnd(function () { requestMeasure(function () { st[1]({ top: el.scrollTop, height: el.clientHeight }); }); });
  });
  useEffect(function () {
    var el = host.current; if (!el) return;
    if (props.stickToBottom) el.scrollTop = el.scrollHeight;
    st[1]({ top: el.scrollTop, height: el.clientHeight });
  }, []);
  var rows = [];
  for (var j = first; j <= last && items.length; j++) {
    var key = props.getKey(items[j], j);
    rows.push(h('div', { key: key, 'data-vkey': key, class: 'rl-vrow', style: { transform: 'translateY(' + offsets[j] + 'px)' } }, props.render(items[j], j)));
  }
  var raf = useRef(0);
  return h('div', { ref: host, class: cx('rl-vlist', props.class), style: props.style, onScroll: function (e) {
      var el = e.currentTarget;
      if (raf.current) return;
      raf.current = 1;
      requestMeasure(function () { raf.current = 0; st[1]({ top: el.scrollTop, height: el.clientHeight }); });
    } },
    h('div', { class: 'rl-vspace', style: { height: acc } }, rows));
}

/* ---------- BottomNav: phone layout tabs ---------- */
function BottomNav(props) {
  return h('nav', { class: 'rl-bnav', 'aria-label': 'Разделы' },
    (props.items || []).map(function (it) {
      return h('button', { key: it.label, type: 'button', class: cx('rl-bnav-item', it.active && 'rl-bnav-on'), 'aria-current': it.active ? 'page' : undefined, onPointerDown: ripple, onClick: it.onClick },
        h('span', { class: 'rl-bnav-pill' }, h(Icon, { name: it.icon, size: 22 }), it.badge ? h(Badge, { count: it.badge }) : null),
        h('span', null, it.label));
    }));
}

/* ---------- Tooltip ---------- */
function Tooltip(props) {
  return h('span', { class: cx('rl-tip-host', props.side && 'rl-tip-' + props.side) },
    props.children, h('span', { class: 'rl-tip', role: 'tooltip' }, props.text));
}

/* =====================================================================
   Wallpaper — animated 4-colour gradient (twallpaper, MIT) + Relay's own doodle pattern
   ===================================================================== */
/* Relay's own doodle sets, drawn for the kit (no Telegram artwork). 24-unit grid, stroke only. */
function circ(x, y, r) { return 'M' + (x - r) + ' ' + y + 'a' + r + ' ' + r + ' 0 1 0 ' + (2 * r) + ' 0a' + r + ' ' + r + ' 0 1 0 ' + (-2 * r) + ' 0'; }
var DOODLES = {
  catHead: ['M4 11l1-7 4.5 3.5h5L19 4l1 7a8 7 0 0 1-16 0z', 'M9 12h.01', 'M15 12h.01', 'M11 14.5h2l-1 1.2z', 'M12 15.7c0 1-1 1.6-2 1.2', 'M12 15.7c0 1 1 1.6 2 1.2', 'M1.5 13.5H6', 'M18 13.5h4.5', 'M2 16.5l4-1.2', 'M22 16.5l-4-1.2'],
  catSit: ['M9 21c-2.5 0-3.5-2-2.5-5.5 1-3.5.8-6-.2-8.5l2.4 1.8h3.6l2.4-1.8c-1 2.5-1.2 5-.2 8.5 1 3.5 0 5.5-2.5 5.5z', 'M10.5 11h.01', 'M13.5 11h.01', 'M15 20c3 .5 5-1 4.5-3.5-.3-1.5-2-1.8-2.5-.5'],
  catSleep: ['M3 17c0-4 4-7 9-7s8 2.5 8 6c0 2-1.5 3-4 3H6c-2 0-3-.8-3-2z', 'M5 12l.5-3 2.5 2', 'M10 11l1.5-2.5 1 3', 'M6 15c.6.5 1.4.5 2 0', 'M16 19c2.5 0 4.5-1 4.5-3', 'M17 6h3l-3 3h3'],
  dogHead: ['M6.5 6C3.5 6 2.5 11 3.5 15l3-2', 'M17.5 6c3 0 4 5 3 9l-3-2', 'M6.5 6c2-2 9-2 11 0v8.5a5.5 5.5 0 0 1-11 0z', 'M9.5 11h.01', 'M14.5 11h.01', 'M10.8 14.5h2.4l-1.2 1.4z', 'M12 15.9v1.6', 'M10.5 18.2c.9.6 2.1.6 3 0'],
  dogRun: ['M3 12c2-1 4-1 6 0h7l2-3 3 1-1 3-2 1v3l1 3', 'M9 12l-2 4-1 3', 'M12 13v3l-1 3', 'M16 14l1 5', 'M3 12l-1-2', 'M19 10.5h.01'],
  paw: [circ(12, 15.5, 3.6), circ(6.8, 10, 1.7), circ(10.3, 6.8, 1.7), circ(13.7, 6.8, 1.7), circ(17.2, 10, 1.7)],
  bone: ['M7.5 9.5a2.2 2.2 0 1 1 2-3l5 5a2.2 2.2 0 1 1 3 2 2.2 2.2 0 1 1-2 3l-5-5a2.2 2.2 0 1 1-3-2z'],
  fish: ['M3 12c3.5-5 10.5-6 14 0-3.5 6-10.5 5-14 0z', 'M17 12l4.5-3.5v7z', 'M7.5 11h.01', 'M10 9.5c.8 1.5.8 3.5 0 5'],
  yarn: [circ(11, 12, 7), 'M5.5 9c4 .8 8 4 10 9', 'M8 5.5c2 3 3 8 2 13', 'M17.5 8.5c-4 .5-9 4.5-11 9', 'M17 17.5c2 0 3 1 4 3'],
  doghouse: ['M3.5 11.5L12 4l8.5 7.5', 'M5.5 10v10h13V10', 'M9.5 20v-4.5a2.5 2.5 0 0 1 5 0V20', 'M11 7.5h2'],
  bowl: ['M3 12.5h18a9 5.5 0 0 1-18 0z', 'M7.5 12.5c0-2.5 2-3.5 4.5-3.5s4.5 1 4.5 3.5', 'M9 6.5l1.5 2', 'M13.5 6l.5 2.5'],
  ball: [circ(12, 12, 8), 'M4.5 9.5c5 1.5 10 1.5 15 0', 'M4.5 14.5c5-1.5 10-1.5 15 0'],
  balloon: ['M12 2.5c3 0 5.5 2.8 5.5 6.2S14.5 15 12 15s-5.5-2.9-5.5-6.3S9 2.5 12 2.5z', 'M11 15l1 1.5 1-1.5', 'M12 16.5c1.2 1.8-1.2 3 0 5'],
  bird: ['M3.5 13c3 0 5-4 9-4 2.8 0 4 1.8 7 1-1.8 3.2-5 6-10 6-3 0-5-1-6-3z', 'M14.5 10l1.8-3', 'M13.8 12h.01'],
  heart: ['M12 19.5s-7-4.3-7-9.7a3.9 3.9 0 0 1 7-2.3 3.9 3.9 0 0 1 7 2.3c0 5.4-7 9.7-7 9.7z'],
  mouse: ['M4 15.5c0-4 4-7 9-7 3 0 5.5 2 5.5 4s-2 3-5 3z', 'M4 15.5c-2 .2-2.5 2.5-1 4', circ(15.5, 8.3, 1.8), 'M16 12h.01'],
  feather: ['M19 4c-7 0-12 5-13 13l-2 3', 'M19 4c0 7-5 12-13 13', 'M10 10l3 3'],
  plane: ['M3.5 11.5L20.5 4l-5 16-3.5-6.5z', 'M12 13.5l8.5-9.5'],
  swirl: ['M12 12a2 2 0 1 1 2 2 4 4 0 1 1-4-4 6 6 0 1 1 6 6'],
  dot: [circ(12, 12, 1.4)],
  cloudSmall: ['M7 18h10a3.5 3.5 0 0 0 .5-7A5.5 5.5 0 0 0 7 10.3 3.9 3.9 0 0 0 7 18z']
};
var PATTERN_SETS = {
  catsAndDogs: ['catHead', 'paw', 'bone', 'dogHead', 'fish', 'yarn', 'catSit', 'doghouse', 'ball', 'dot', 'balloon', 'dogRun', 'heart', 'bowl', 'mouse', 'catSleep', 'swirl', 'bird', 'plane', 'feather', 'paw', 'cloudSmall', 'dot', 'heart'],
  doodles: ['chats', 'send', 'mic', 'check', 'clock', 'image', 'smile', 'phone', 'star', 'attach', 'camera', 'poll', 'lock', 'video', 'cloud', 'pin', 'bell', 'palette', 'contact', 'link']
};
/* Цвет узора выводится из фона, а не хранится отдельно: насыщенность чуть выше,
   яркость ×0.65 на светлом фоне (на тёмном — наоборот, светлее), прозрачность 40%.
   Так любые обои сразу получают узор в своём тоне. */
function parseHex(c) {
  var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}
function patternColor(colors) {
  var rgb = [0, 0, 0], n = 0;
  colors.forEach(function (c) { var x = parseHex(c); if (x) { rgb[0] += x[0]; rgb[1] += x[1]; rgb[2] += x[2]; n++; } });
  if (!n) return 'rgba(0,0,0,0.4)';
  var r = rgb[0] / n / 255, g = rgb[1] / n / 255, b = rgb[2] / n / 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, hue = 0;
  if (d) hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  var sat = max ? d / max : 0, val = max;
  sat = Math.min(1, sat + 0.05 + 0.1 * (1 - sat));
  val = val > 0.5 ? val * 0.65 : Math.min(1, 1 - val * 0.65);
  var f = function (k) { var x = (k + hue / 60) % 6; return Math.round(255 * (val - val * sat * Math.max(0, Math.min(x, 4 - x, 1)))); };
  return 'rgba(' + f(5) + ',' + f(3) + ',' + f(1) + ',0.4)';
}
var patternCache = Object.create(null);
function buildPattern(set, stroke) {
  set = set || 'catsAndDogs';
  stroke = stroke || '#000';
  var cacheKey = set + '|' + stroke;
  // ключи — из localStorage пользователя: только собственные свойства (не __proto__ / constructor)
  if (Object.prototype.hasOwnProperty.call(patternCache, cacheKey)) return patternCache[cacheKey];
  if (!Object.prototype.hasOwnProperty.call(PATTERN_SETS, set)) set = 'catsAndDogs';
  var names = PATTERN_SETS[set];
  cacheKey = set + '|' + stroke;
  // deterministic scatter on a 420×420 tile (same tile size as the reference settings): 10×10 staggered, jittered cells
  var out = [], seed = set.length * 7 + 11, n = 0, G = 10, cell = 420 / G;
  function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
  for (var y = 0; y < G; y++) for (var x = 0; x < G; x++) {
    var name = names[(n++ * 7 + y) % names.length];
    var d = DOODLES[name] || ICONS[name];
    var small = name === 'dot' || name === 'swirl' || name === 'heart';
    var px = (x + (y % 2) * 0.5) * cell + cell / 2 + (rnd() - 0.5) * cell * 0.5, py = y * cell + cell / 2 + (rnd() - 0.5) * cell * 0.5;
    var rot = Math.round((rnd() - 0.5) * 80), sc = (small ? 0.75 + rnd() * 0.35 : 1.3 + rnd() * 0.45).toFixed(2);
    var body = d.map(function (p) { return '<path d="' + p + '"/>'; }).join('');
    [[0, 0], [-420, 0], [420, 0], [0, -420], [0, 420]].forEach(function (o) {
      var qx = px + o[0], qy = py + o[1];
      if (qx < -30 || qx > 450 || qy < -30 || qy > 450) return; // only copies that touch the tile
      out.push('<g transform="translate(' + qx.toFixed(1) + ' ' + qy.toFixed(1) + ') rotate(' + rot + ') scale(' + sc + ') translate(-12 -12)">' + body + '</g>');
    });
  }
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="420" viewBox="0 0 420 420" fill="none" stroke="' + stroke + '" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">' + out.join('') + '</svg>';
  // twallpaper wraps the value in url(…) itself, so pass a quoted data URI
  patternCache[cacheKey] = '"data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '"';
  return patternCache[cacheKey];
}
var wallpapers = [];
/* Shift every mounted wallpaper's gradient one step — call on send / receive, like Telegram. */
function wpMotion() { return !reducedMotion() && document.documentElement.dataset.wpanim !== '0'; }
function nudgeWallpaper() {
  if (!wpMotion()) return; // «Анимация обоев» выключена — градиент стоит
  wallpapers.forEach(function (w) { var end = beginHeavyAnimation(700); w.toNextPosition(end); });
}
function readTheme(el) {
  var cs = getComputedStyle(el), dark = false;
  var colors = [1, 2, 3, 4].map(function (i) { return cs.getPropertyValue('--wallpaper-' + i).trim() || '#dfe9d6'; });
  var bg = cs.getPropertyValue('--bg').trim();
  // dark theme = dark page background
  var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(bg);
  if (m) dark = (parseInt(m[1], 16) + parseInt(m[2], 16) + parseInt(m[3], 16)) / 3 < 96;
  return { colors: colors, dark: dark, ink: cs.getPropertyValue('--wallpaper-pattern').trim() || '#000000' };
}
var TW_VARS = ['--tw-image', '--tw-size', '--tw-opacity', '--tw-blur', '--tw-background'];
/* Снимок текущих обоев поверх хоста: после смены цветов/узора тает за 300 мс (кроссфейд без вспышки). */
function crossfadeSnapshot(el) {
  var cv = el.querySelector('canvas.tw-canvas');
  if (!cv || !cv.width) return;
  var snap = document.createElement('div');
  snap.className = 'rl-tw-snap';
  TW_VARS.forEach(function (v) { snap.style.setProperty(v, el.style.getPropertyValue(v)); });
  var copy = document.createElement('canvas');
  copy.width = cv.width; copy.height = cv.height; copy.className = cv.className;
  try { copy.getContext('2d').drawImage(cv, 0, 0); } catch (e) { return; }
  snap.appendChild(copy);
  var pat = el.querySelector('.tw-pattern');
  if (pat) snap.appendChild(pat.cloneNode(false));
  el.appendChild(snap);
  var end = beginHeavyAnimation(320);
  requestAnimationFrame(function () { requestAnimationFrame(function () { snap.style.opacity = '0'; }); });
  setTimeout(function () { snap.remove(); end(); }, 340);
}
/* props: pattern (имя набора | false), colors (4 цвета | null = из темы), blur (bool).
   Смена props применяется на лету; первое применение и смена темы — без снимка. */
function Wallpaper(props) {
  var host = useRef(null);
  var latest = useRef(props);
  latest.current = props;
  var rerun = useRef(null);
  useEffect(function () {
    var el = host.current, wp = null, theme = null, lastKey = '';
    function apply(animate) {
      requestMeasure(function () {
        var P = latest.current;
        // идёт смена темы: токены на <html> смешиваются (rgba, не hex) — применим по снятию класса
        if (document.documentElement.classList.contains('rl-theme-switching')) return;
        var t = readTheme(el);
        // props.dark — тема, с которой отрисован App; DOM переключился раньше рендера: ждём props (эффект по ним применит один раз)
        if (typeof P.dark === 'boolean' && P.dark !== t.dark) return;
        var custom = P.colors && P.colors.length >= 4 ? P.colors.slice(0, 4) : null;
        var colors = custom || t.colors;
        var key = [t.dark, colors.join(), P.pattern].join('|');
        if (theme && key === lastKey) return;
        var modeChanged = theme && t.dark !== theme.dark;
        var themeSwitch = !theme || modeChanged || (!custom && t.colors.join() !== theme.colors.join());
        theme = t; lastKey = key;
        requestMutation(function () {
          // светлая ↔ тёмная: узор меняет режим (маска ↔ рисунок), а updatePattern режим маски не снимает — собираем заново
          if (wp && modeChanged) { wallpapers.splice(wallpapers.indexOf(wp), 1); wp.dispose(); wp = null; }
          var set = typeof P.pattern === 'string' ? P.pattern : 'catsAndDogs';
          var pattern = P.pattern === false ? undefined : t.dark
            ? { image: buildPattern(set), mask: true, background: t.ink, size: '420px', opacity: P.maskOpacity || 0.55 }
            // светлая тема: узор нарисован цветом, выведенным из фона (прозрачность уже в цвете)
            : { image: buildPattern(set, patternColor(colors)), mask: false, background: 'transparent', size: '420px', opacity: 1, blur: 0 };
          if (!wp) {
            wp = new TWallpaper(el, { colors: colors, fps: 60, tails: 90, animate: !!P.animate && wpMotion(), scrollAnimate: !!P.scrollAnimate && wpMotion(), pattern: pattern });
            wp.init();
            wallpapers.push(wp);
          } else {
            if (animate && !themeSwitch && !reducedMotion()) crossfadeSnapshot(el);
            wp.updateColors(colors);
            if (typeof wp.drawGradient === 'function') wp.drawGradient();
            if (pattern) wp.updatePattern(pattern);
          }
        });
      });
    }
    rerun.current = apply;
    apply(false);
    // follow theme switches: data-theme on <html> and the OS setting
    var mo = new MutationObserver(function () { apply(false); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var onMq = function () { apply(false); };
    if (mq && mq.addEventListener) mq.addEventListener('change', onMq);
    return function () {
      mo.disconnect();
      rerun.current = null;
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq);
      if (wp) { wallpapers.splice(wallpapers.indexOf(wp), 1); wp.dispose(); }
    };
  }, []);
  var colorsKey = props.colors ? props.colors.join() : '';
  useEffect(function () { if (rerun.current) rerun.current(true); }, [props.pattern, colorsKey, props.dark]);
  return h('div', { ref: host, class: cx('rl-tw', props.blur && 'rl-tw-blur'), 'aria-hidden': 'true' });
}

/* =====================================================================
   Floating layout (Telegram Web K–style): cards over the wallpaper
   ===================================================================== */

/* ---------- FloatShell: wallpaper everywhere, sidebar card + main area ---------- */
/* ---------- SideResizer: drag the sidebar's right edge to change its width (like Telegram Web K) ----------
   The width lives in a CSS variable on the shell (--side-w), changed once per frame while dragging —
   no Preact render per pointer move. Double-click restores the default. onChange(width|null) on release. */
function SideResizer(props) {
  var min = props.min || 280, max = props.max || 600;
  function clamp(w) { return Math.round(Math.max(min, Math.min(w, Math.min(max, window.innerWidth * 0.45)))); }
  function shellOf(el) { return el.closest('.rl-shell'); }
  function onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    var handle = e.currentTarget, shell = shellOf(handle), side = handle.parentElement;
    var startX = e.clientX, startW = null, w = null, queued = false, lastX = e.clientX;
    requestMeasure(function () { startW = side.getBoundingClientRect().width; if (w === null) w = startW; });
    handle.setPointerCapture(e.pointerId);
    function apply() { queued = false; if (startW === null) return; w = clamp(startW + lastX - startX); shell.style.setProperty('--side-w', w + 'px'); }
    document.documentElement.classList.add('rl-resizing');
    var end = beginHeavyAnimation(60000); // пока тянут — тяжёлую работу откладываем
    function move(ev) {
      lastX = ev.clientX;
      if (queued) return;
      queued = true;
      requestMutation(apply);
    }
    function up(ev) {
      if (ev && ev.clientX !== undefined) lastX = ev.clientX;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      requestMutation(function () {
        apply();
        document.documentElement.classList.remove('rl-resizing');
        end();
        if (props.onChange && w !== null) props.onChange(w);
      });
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  function onDblClick(e) {
    var shell = shellOf(e.currentTarget);
    requestMutation(function () { shell.style.removeProperty('--side-w'); if (props.onChange) props.onChange(null); });
  }
  function onKeyDown(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    var shell = shellOf(e.currentTarget), side = e.currentTarget.parentElement, step = e.key === 'ArrowRight' ? 24 : -24;
    requestMeasure(function () {
      var w = clamp(side.getBoundingClientRect().width + step);
      requestMutation(function () { shell.style.setProperty('--side-w', w + 'px'); if (props.onChange) props.onChange(w); });
    });
  }
  return h('div', { class: 'rl-side-resizer', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Ширина списка чатов', tabIndex: 0,
    onPointerDown: onPointerDown, onDblClick: onDblClick, onKeyDown: onKeyDown, title: 'Потяните, чтобы изменить ширину; двойной клик — по умолчанию' });
}

function FloatShell(props) {
  var ref = useRef(null);
  // начальная ширина — один раз; дальше --side-w ведёт только ручка (иначе каждый рендер затирал бы перетаскивание)
  useLayoutEffect(function () { if (props.sideWidth && ref.current) ref.current.style.setProperty('--side-w', props.sideWidth + 'px'); }, []);
  return h('div', { ref: ref, class: cx('rl-shell rl-wallpaper', props.wallpaper !== false && 'rl-shell-tw', props.class), style: props.style },
    props.wallpaper !== false ? h(Wallpaper, { pattern: props.pattern, colors: props.wallpaperColors, blur: props.wallpaperBlur, dark: props.wallpaperDark }) : null,
    props.rail || null,
    props.sidebar ? h('div', { class: 'rl-shell-side' }, props.sidebar,
      props.onSideResize ? h(SideResizer, { min: props.sideMin, max: props.sideMax, onChange: props.onSideResize }) : null) : null,
    h('div', { class: 'rl-shell-main' }, props.children),
    props.aside || null,
    // слой приватности экрана: виден только при html[data-screen-blur]; клик снимает размытие (логика — в приложении)
    h('div', { class: 'rl-shell-veil', role: 'button', 'aria-label': 'Нажмите, чтобы показать', tabindex: -1 },
      h('span', { class: 'rl-shell-veil-card' }, h(Icon, { name: 'lock', size: 28 }), h('span', null, 'Нажмите, чтобы показать'))));
}

/* ---------- SidebarCard: header, folder tabs, scrolling body, FAB that hides on scroll down ---------- */
function SidebarCard(props) {
  var fab = useState(true), last = useRef(0), pending = useRef(false);
  function onScroll(e) {
    var el = e.target; // the scroller that moved (body itself or a page inside it)
    if (!el || !('scrollTop' in el)) return; // только проверка свойства — без чтения раскладки
    if (pending.current) return;
    pending.current = true;
    requestMeasure(function () {
      pending.current = false;
      var top = el.scrollTop, d = top - last.current;
      last.current = top;
      if (Math.abs(d) < 4) return;
      var show = d < 0 || top < 24;
      if (show !== fab[0]) fab[1](show);
    });
  }
  // Вкладки (и подсказка над ними) — слой поверх списка, как в Telegram: список уходит под него,
  // а его отступ сверху равен высоте слоя (--over-h; меняется плавно, когда подсказка раскрывается)
  var main = useRef(null), over = useRef(null);
  var floating = !!(props.tabs || props.top);
  useLayoutEffect(function () {
    var el = over.current, host = main.current;
    if (!el || !host || typeof ResizeObserver !== 'function') return;
    var ro = new ResizeObserver(function (entries) {
      var b = entries[0].borderBoxSize && entries[0].borderBoxSize[0];
      var hgt = b ? b.blockSize : entries[0].contentRect.height;
      requestMutation(function () { host.style.setProperty('--over-h', Math.round(hgt) + 'px'); });
    });
    ro.observe(el);
    return function () { ro.disconnect(); };
  }, [floating]);
  var body = h('div', { class: cx('rl-sidecard-body', props.paged && 'rl-sidecard-paged'), onScrollCapture: onScroll }, props.children);
  // embedded: a page inside SideFrame/SlideStack — same content, the card surface belongs to the frame
  return h(props.embedded ? 'div' : 'section', { class: cx(props.embedded ? 'rl-sidepage' : 'rl-sidecard', props.class), 'aria-label': props.label || 'Чаты' },
    props.header || null,
    props.banner || null,
    floating
      ? h('div', { ref: main, class: 'rl-sidecard-main' },
        h('div', { ref: over, class: 'rl-sidecard-over' }, props.top || null, props.tabs || null),
        body)
      : body,
    props.fab ? h('div', { class: cx('rl-fab-slot', !fab[0] && 'rl-fab-hidden') }, props.fab) : null,
    props.overlay || null);   // поверх списка у нижнего края (например «Обновить»)
}

/* ---------- SidebarHeader: menu, search pill, avatar ---------- */
function SidebarHeader(props) {
  return h('div', { class: 'rl-sidehead' },
    props.back
      ? h(IconButton, { icon: 'arrowLeft', label: 'Назад', onClick: props.onBack, class: 'rl-sidehead-back' })
      : h(IconButton, { icon: 'menu', label: 'Меню', onClick: props.onMenu }),
    h(SearchField, { id: props.searchId || 'rl-side-search', placeholder: props.placeholder || 'Поиск', status: props.status, value: props.value, onInput: props.onSearch, class: 'rl-sidehead-search' }),
    props.trailing !== undefined ? props.trailing : props.me ? h('button', { type: 'button', class: 'rl-sidehead-me', 'aria-label': 'Профиль', onClick: props.onMe }, h(Avatar, { name: props.me, tone: props.meTone, size: 36 })) : null);
}

/* ---------- FolderTabs: pills with counters, one sliding indicator (measure → mutate) ---------- */
/* FolderTabs — полоса табов (папки, вкладки медиа). Белая полоса с тенью; два слоя подписей:
   нижний — серые кнопки, верхний (aria-hidden) — те же подписи в цвете бренда на светлой таблетке.
   Верхний слой виден только в окне clip-path над активным табом; окно переезжает плавно, и текст
   перекрашивается ровно там, где проходит таблетка. */
function FolderTabs(props) {
  var host = useRef(null), track = useRef(null), top = useRef(null), first = useRef(true);
  var items = props.items || [];
  // instant: без анимации — первый показ и смена ширины полосы (таблетка не «тянется», а сразу на месте)
  function place(instant) {
    requestMeasure(function () {
      var tr = track.current, el = tr && tr.querySelector('.rl-tab[aria-selected="true"]');
      if (!el || !host.current) return;
      var x = el.offsetLeft, w = el.offsetWidth, tw = tr.offsetWidth, sl = host.current.scrollLeft, cw = host.current.clientWidth;
      requestMutation(function () {
        var s = top.current.style;
        if (instant || first.current || reducedMotion()) { s.transition = 'none'; first.current = false; } else { s.transition = ''; beginHeavyAnimation(300); }
        s.clipPath = 'inset(0 ' + (tw - x - w) + 'px 0 ' + x + 'px round 18px)';
        // активный таб — в зоне видимости полосы
        if (!instant && (x < sl || x + w > sl + cw)) host.current.scrollTo({ left: x - 24, behavior: reducedMotion() ? 'auto' : 'smooth' });
      });
    });
  }
  useLayoutEffect(function () { place(false); }, [props.active, items.map(function (t) { return t.id + ':' + (t.count || 0); }).join(',')]);
  // ширина полосы меняется (панель тянут за край, окно) — таблетка следует за вкладкой сразу
  useLayoutEffect(function () {
    if (typeof ResizeObserver !== 'function' || !track.current) return;
    var seen = false;
    var ro = new ResizeObserver(function () { if (seen) place(true); seen = true; });
    ro.observe(track.current);
    return function () { ro.disconnect(); };
  }, []);
  function onKey(e) {
    var i = items.findIndex(function (t) { return t.id === props.active; });
    if (e.key === 'ArrowRight' && i < items.length - 1) props.onChange(items[i + 1].id);
    if (e.key === 'ArrowLeft' && i > 0) props.onChange(items[i - 1].id);
  }
  function inner(t, active) {
    return [h('span', { key: 'l' }, t.label),
      t.count ? h('span', { key: 'c' + t.count, class: cx('rl-folder-count', t.muted && 'rl-folder-count-muted', active && 'rl-folder-count-on') }, t.count > 999 ? '999+' : t.count) : null];
  }
  return h('div', { ref: host, class: cx('rl-tabs', props.class), role: 'tablist', 'aria-label': props.label || 'Папки', onKeyDown: onKey },
    h('div', { ref: track, class: 'rl-tabs-track' },
      items.map(function (t) {
        var on = t.id === props.active;
        return h('button', { key: t.id, type: 'button', role: 'tab', 'aria-selected': String(on), tabIndex: on ? 0 : -1, class: 'rl-tab', onPointerDown: ripple, onClick: function () { props.onChange(t.id); }, onContextMenu: props.onItemMenu ? function (e) { e.preventDefault(); props.onItemMenu(t.id, e); } : undefined }, inner(t, false));
      }),
      h('div', { ref: top, class: 'rl-tabs-top', 'aria-hidden': 'true' },
        items.map(function (t) { return h('span', { key: t.id, class: 'rl-tab' }, inner(t, true)); }))));
}

/* ---------- FolderRail: папки колонкой слева (иконка, бейдж на иконке, подпись), таблетка под активной ---------- */
/* Отдельная карточка слева от списка чатов. Подложка активной папки — один элемент, переезжает transform'ом
   (замер в requestMeasure, запись в requestMutation; первый показ и смена размеров — без анимации). */
function FolderRail(props) {
  var list = useRef(null), pill = useRef(null), first = useRef(true);
  var items = props.items || [];
  function place(instant) {
    requestMeasure(function () {
      var el = list.current && list.current.querySelector('.rl-frail-item[aria-selected="true"]');
      if (!el || !pill.current) return;
      var y = el.offsetTop, hgt = el.offsetHeight;
      var sc = list.current, st = sc.scrollTop, ch = sc.clientHeight;
      requestMutation(function () {
        var s = pill.current.style;
        if (instant || first.current || reducedMotion()) { s.transition = 'none'; first.current = false; } else { s.transition = ''; beginHeavyAnimation(300); }
        s.transform = 'translateY(' + y + 'px)';
        s.height = hgt + 'px';
        s.opacity = '1';
        if (!instant && (y < st || y + hgt > st + ch)) sc.scrollTo({ top: y - 16, behavior: reducedMotion() ? 'auto' : 'smooth' });
      });
    });
  }
  useLayoutEffect(function () { place(false); }, [props.active, items.map(function (t) { return t.id; }).join(',')]);
  useLayoutEffect(function () {
    if (typeof ResizeObserver !== 'function' || !list.current) return;
    var seen = false;
    var ro = new ResizeObserver(function () { if (seen) place(true); seen = true; });
    ro.observe(list.current);
    return function () { ro.disconnect(); };
  }, []);
  function onKey(e) {
    var i = items.findIndex(function (t) { return t.id === props.active; });
    if (e.key === 'ArrowDown' && i < items.length - 1) { e.preventDefault(); props.onChange(items[i + 1].id); }
    if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); props.onChange(items[i - 1].id); }
  }
  return h('nav', { class: cx('rl-frail', props.class), 'aria-label': props.label || 'Папки' },
    h('div', { ref: list, class: 'rl-frail-list', role: 'tablist', 'aria-orientation': 'vertical', onKeyDown: onKey },
      h('div', { ref: pill, class: 'rl-frail-pill', 'aria-hidden': 'true' }),
      items.map(function (t) {
        var on = t.id === props.active;
        return h('button', { key: t.id, type: 'button', role: 'tab', 'aria-selected': String(on), tabIndex: on ? 0 : -1, class: 'rl-frail-item', title: t.label,
          onClick: function () { props.onChange(t.id); },
          onContextMenu: props.onItemMenu ? function (e) { e.preventDefault(); props.onItemMenu(t.id, e); } : undefined },
          h('span', { class: 'rl-frail-icon' },
            t.emoji ? h('span', { class: 'rl-frail-emoji', 'aria-hidden': 'true' }, t.emoji) : h(Icon, { name: t.icon || 'folder', size: 28 }),
            t.count ? h('span', { class: cx('rl-frail-count', t.muted && 'rl-frail-count-muted') }, t.count > 99 ? '99+' : t.count) : null),
          h('span', { class: 'rl-frail-label' }, t.label));
      })),
    props.onSettings ? h(IconButton, { icon: 'settings', label: props.settingsLabel || 'Настройки папок', class: 'rl-frail-settings', onClick: props.onSettings }) : null);
}

/* ---------- Fab ---------- */
function Fab(props) {
  return h('button', { type: 'button', class: 'rl-fab-main', 'aria-label': props.label, onPointerDown: ripple, onClick: props.onClick },
    h(Icon, { name: props.icon || 'pencil', size: 24 }));
}

/* ---------- GlassBar: floating chat header over the wallpaper ---------- */
function GlassBar(props) {
  return h('header', { class: cx('rl-glassbar', props.class) }, props.children);
}

export { patternColor, Wallpaper, nudgeWallpaper, buildPattern, DOODLES, PATTERN_SETS, FloatShell, SideResizer, SidebarCard, SidebarHeader, FolderTabs, FolderRail, Fab, GlassBar, WindowList, AsidePanel, SideFrame, SlideStack, Menu, ReactionPicker, AttachMenu, MentionList, DropOverlay, LinkPreview, PollBubble, UnreadDivider, SelectionBar, ChatSearchBar, Highlight, ContactPicker, CallRow, StatusAvatar, LoginQR, VirtualList, BottomNav, Tooltip, plural };
