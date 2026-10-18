import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { Icon, SettingsIcon, cx, ripple } from './kit.js';
import { Modal } from './modal.js';

/* Компоненты страниц настроек: карточки-секции, радио/чекбокс-строки, слайдер, поле, выбор, подтверждение, текст со ссылками. */

export { SettingsIcon };

var uid = 0;
function nextId(p) { return p + (++uid); }
// id создаётся один раз на экземпляр, а не на каждый рендер
function useId(p, given) { var r = useRef(null); if (r.current === null) r.current = nextId(p); return given || r.current; }

/* ---------- Section: заголовок + карточка + подпись снизу ---------- */
// role="radiogroup": стрелки ↑/↓ двигают выбор между RadioRow
function radioKeys(e) {
  var k = e.key;
  if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
  var items = Array.prototype.slice.call(e.currentTarget.querySelectorAll('[role="radio"]:not([disabled])'));
  var i = items.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  var step = (k === 'ArrowDown' || k === 'ArrowRight') ? 1 : -1;
  var next = items[(i + step + items.length) % items.length];
  next.focus(); next.click();
}
function Section(props) {
  var id = useId('rl-sect-', props.id);
  var group = props.role === 'radiogroup';
  var cardRef = useRef(null);
  // roving tabindex: Tab-стоп — выбранный радио, а если выбранного нет — первый доступный
  useLayoutEffect(function () {
    if (!group || !cardRef.current) return;
    var rs = Array.prototype.slice.call(cardRef.current.querySelectorAll('[role="radio"]'));
    var stop = rs.filter(function (r) { return r.getAttribute('aria-checked') === 'true' && !r.disabled; })[0] || rs.filter(function (r) { return !r.disabled; })[0];
    rs.forEach(function (r) { r.tabIndex = r === stop ? 0 : -1; });
  });
  return h('section', { class: cx('rl-sect', (props.className || props.class)) },
    props.title ? h('h3', { class: 'rl-sect-title', id: id }, props.title) : null,
    h('div', { class: 'rl-sect-card', ref: cardRef, role: props.role, 'aria-labelledby': props.title ? id : undefined, onKeyDown: group ? radioKeys : undefined }, props.children),
    props.footer ? h('p', { class: 'rl-sect-footer' }, props.footer) : null);
}

/* ---------- RadioRow / CheckRow ---------- */
function RadioRow(props) {
  return h('button', { type: 'button', role: 'radio', 'aria-checked': props.checked ? 'true' : 'false', disabled: props.disabled,
    tabIndex: props.checked ? 0 : -1, class: cx('rl-optrow', props.checked && 'rl-optrow-on'),
    onPointerDown: ripple, onClick: props.onClick || props.onChange },
    h('span', { class: 'rl-radio', 'aria-hidden': 'true' }),
    h('span', { class: 'rl-optrow-text' }, h('span', null, props.label || props.title), props.subtitle ? h('small', null, props.subtitle) : null));
}
function CheckRow(props) {
  return h('label', { class: cx('rl-check', 'rl-optrow', props.disabled && 'rl-optrow-off') },
    h('input', { type: 'checkbox', checked: !!props.checked, disabled: props.disabled, onChange: function (e) { if (props.onChange) props.onChange(e.currentTarget.checked, e); } }),
    h('span', { class: 'rl-check-box', 'aria-hidden': 'true' },
      h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, h('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }))),
    h('span', { class: 'rl-optrow-text' }, h('span', null, props.label || props.title), props.subtitle ? h('small', null, props.subtitle) : null));
}

/* ---------- RangeRow: подпись, значение справа, слайдер (←/→ нативно, aria-valuetext); onChange — пока тянут, onCommit — когда отпустили ---------- */
function RangeRow(props) {
  var min = props.min != null ? props.min : 0, max = props.max != null ? props.max : 100, step = props.step || 1;
  var value = props.value != null ? props.value : min;
  var fmt = props.format || function (v) { return String(v); };
  var pct = max > min ? (value - min) / (max - min) * 100 : 0;
  var id = useId('rl-range-', props.id);
  var marks = props.marks;
  return h('div', { class: cx('rl-range', props.disabled && 'rl-range-off') },
    h('div', { class: 'rl-range-head' },
      h('label', { for: id }, props.label),
      h('output', { class: 'rl-range-value', for: id }, fmt(value))),
    h('input', { id: id, type: 'range', class: 'rl-range-input', min: min, max: max, step: step, value: value, disabled: props.disabled,
      style: '--pct:' + pct + '%', 'aria-valuetext': fmt(value),
      onInput: function (e) { if (props.onChange) props.onChange(Number(e.currentTarget.value), e); },
      // change у range приходит при отпускании ползунка (и после клавиши)
      onChange: function (e) { if (props.onCommit) props.onCommit(Number(e.currentTarget.value), e); } }),
    marks && marks.length ? h('div', { class: 'rl-range-marks', 'aria-hidden': 'true' }, marks.map(function (m, i) {
      var v = typeof m === 'object' ? m.value : m, label = typeof m === 'object' ? m.label : fmt(m);
      return h('span', { key: i, style: 'left:' + (max > min ? (v - min) / (max - min) * 100 : 0) + '%' }, label);
    })) : null);
}

/* ---------- TextField: плавающая подпись, счётчик «осталось», ошибка ----------
   measure(value) — своя длина (например, в кодовых точках, как считает сервер): тогда нативный maxLength
   (UTF-16) не ставится, а обрезает вызывающий в onInput. */
function TextField(props) {
  var id = useId('rl-field-', props.id);
  var value = props.value == null ? '' : String(props.value);
  var left = props.maxLength != null ? props.maxLength - (props.measure ? props.measure(value) : value.length) : null;
  var showCount = props.counter && left != null;
  var Tag = props.multiline ? 'textarea' : 'input';
  var err = props.error;
  return h('div', { class: cx('rl-tf', value && 'rl-tf-filled', err && 'rl-tf-error', props.multiline && 'rl-tf-multi', (props.className || props.class)) },
    h('div', { class: 'rl-tf-box' },
      h(Tag, { id: id, class: 'rl-tf-input', value: value, placeholder: ' ', maxLength: props.measure ? undefined : props.maxLength, disabled: props.disabled, rows: props.multiline ? (props.rows || 3) : undefined,
        type: props.multiline ? undefined : (props.type || 'text'), autoComplete: props.autoComplete || 'off', inputMode: props.inputMode, autoFocus: props.autoFocus,
        'aria-invalid': err ? 'true' : undefined, 'aria-describedby': err ? id + '-err' : undefined,
        onInput: function (e) { if (props.onInput) props.onInput(e.currentTarget.value, e); },
        onBlur: props.onBlur, onKeyDown: props.onKeyDown }),
      h('label', { class: 'rl-tf-label', for: id }, props.label),
      showCount ? h('span', { class: cx('rl-tf-count', left <= 5 && 'rl-tf-count-low'), 'aria-hidden': 'true' }, left) : null),
    h('div', { class: 'rl-tf-msg', id: id + '-err', role: 'status', 'aria-live': 'polite' }, err || (props.hint || '')));
}

/* ---------- SelectRow: подпись слева, значение и ▾ справа; нативный select поверх ---------- */
function SelectRow(props) {
  var id = useId('rl-sel-', props.id);
  var opts = props.options || [];
  var cur = opts.filter(function (o) { return o.value === props.value; })[0];
  return h('div', { class: cx('rl-selrow', props.disabled && 'rl-optrow-off') },
    h('label', { class: 'rl-selrow-label', for: id }, props.label),
    h('span', { class: 'rl-selrow-value', 'aria-hidden': 'true' }, cur ? cur.label : '', h(Icon, { name: 'chevronDown', size: 18 })),
    h('select', { id: id, class: 'rl-selrow-native', value: props.value, disabled: props.disabled, onChange: function (e) {
      var v = e.currentTarget.value, o = opts.filter(function (x) { return String(x.value) === v; })[0];
      if (props.onChange) props.onChange(o ? o.value : v, e);
    } }, opts.map(function (o) { return h('option', { key: o.value, value: o.value }, o.label); })));
}

/* ---------- ConfirmDialog: подтверждение на общем слое модалок (modal.js), Esc/подложка — отмена ----------
   Кнопки — текстовые справа, как в Telegram; у опасного действия фокус на «Отмена». */
function ConfirmDialog(props) {
  var open = props.open !== false;
  return h(Modal, {
    open: open, onClose: props.onCancel, title: props.title, size: 'confirm', role: 'alertdialog', closeButton: false,
    actions: [
      h('button', { key: 'no', type: 'button', class: 'rl-mdl-btn', 'data-autofocus': props.danger ? '' : undefined, onClick: props.onCancel }, props.cancel || 'Отмена'),
      props.extra ? h('button', { key: 'ex', type: 'button', class: 'rl-mdl-btn', onClick: props.extra.onClick }, props.extra.label) : null,
      h('button', { key: 'ok', type: 'button', class: cx('rl-mdl-btn', props.danger && 'rl-mdl-btn-danger'), 'data-autofocus': props.danger ? undefined : '', onClick: props.onConfirm }, props.confirm || 'Ок'),
    ],
  }, props.text ? h('p', { class: 'rl-mdl-text' }, props.text) : null);
}

/* ---------- RichText: текст → узлы (текст / http(s)-ссылка / @упоминание), без innerHTML ---------- */
var RICH_RE = /(?<![\w@\/.])((?:https?:\/\/|www\.)[^\s<>"'`]+)|(?<![\w@])(@[a-zA-Z][a-zA-Z0-9_]{4,31})(?![a-zA-Z0-9_])/gi;
var TRAIL = '.,!?)';
function trimUrl(u) {
  while (u.length) {
    var c = u[u.length - 1];
    if (TRAIL.indexOf(c) < 0) break;
    if (c === ')' && u.split(')').length <= u.split('(').length) break; // скобка из самого адреса
    u = u.slice(0, -1);
  }
  return u;
}
function parseRich(text) {
  text = text == null ? '' : String(text);
  var out = [], last = 0, m;
  function push(t, v, href) {
    if (t === 'text') { if (!v) return; var p = out[out.length - 1]; if (p && p.t === 'text') { p.v += v; return; } }
    out.push(href ? { t: t, v: v, href: href } : { t: t, v: v });
  }
  RICH_RE.lastIndex = 0;
  while ((m = RICH_RE.exec(text))) {
    var start = m.index;
    if (m[1]) {
      var u = trimUrl(m[1]), href = /^www\./i.test(u) ? 'https://' + u : u, ok = false;
      try { var p = new URL(href); ok = (p.protocol === 'http:' || p.protocol === 'https:') && !!p.hostname && p.hostname.indexOf('.') > 0 || p.hostname === 'localhost'; } catch (_) { ok = false; }
      if (!ok) { push('text', text.slice(last, start + m[1].length)); last = start + m[1].length; continue; }
      push('text', text.slice(last, start));
      push('link', u, href);
      last = start + u.length;
      RICH_RE.lastIndex = last;
    } else {
      push('text', text.slice(last, start));
      push('mention', m[2]);
      last = start + m[2].length;
    }
  }
  push('text', text.slice(last));
  return out;
}
function RichText(props) {
  var parts = parseRich(props.text);
  return h('span', { class: cx('rl-rich', (props.className || props.class)) }, parts.map(function (p, i) {
    if (p.t === 'link') return h('a', { key: i, class: 'rl-rich-link', href: p.href, target: '_blank', rel: 'noopener noreferrer' }, p.v);
    if (p.t === 'mention') {
      return props.onMention
        ? h('button', { key: i, type: 'button', class: 'rl-rich-link rl-rich-mention', onClick: function () { props.onMention(p.v.slice(1)); } }, p.v)
        : h('span', { key: i, class: 'rl-rich-mention' }, p.v);
    }
    return p.v;
  }));
}

export { Section, RadioRow, CheckRow, RangeRow, TextField, SelectRow, ConfirmDialog, RichText, parseRich };
