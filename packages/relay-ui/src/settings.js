import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon, SettingsIcon, cx, ripple } from './kit.js';
import { Modal } from './modal.js';

/* Компоненты страниц настроек: карточки-секции, радио/чекбокс-строки, слайдер, поле, выбор, подтверждение, текст со ссылками.
   setting — якорь поиска по настройкам (data-setting): к строке прокручивают и подсвечивают её. */

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
  return h('section', { class: cx('rl-sect', (props.className || props.class)), 'data-setting': props.setting },
    props.title ? h('h3', { class: 'rl-sect-title', id: id }, props.title) : null,
    h('div', { class: 'rl-sect-card', ref: cardRef, role: props.role, 'aria-labelledby': props.title ? id : undefined, onKeyDown: group ? radioKeys : undefined }, props.children),
    props.footer ? h('p', { class: 'rl-sect-footer' }, props.footer) : null);
}

/* ---------- RadioRow / CheckRow ---------- */
function RadioRow(props) {
  return h('button', { type: 'button', role: 'radio', 'aria-checked': props.checked ? 'true' : 'false', disabled: props.disabled, 'data-setting': props.setting,
    tabIndex: props.checked ? 0 : -1, class: cx('rl-optrow', props.checked && 'rl-optrow-on'),
    onPointerDown: ripple, onClick: props.onClick || props.onChange },
    h('span', { class: 'rl-radio', 'aria-hidden': 'true' }),
    h('span', { class: 'rl-optrow-text' }, h('span', null, props.label || props.title), props.subtitle ? h('small', null, props.subtitle) : null));
}
function CheckRow(props) {
  return h('label', { class: cx('rl-check', 'rl-optrow', props.disabled && 'rl-optrow-off'), 'data-setting': props.setting },
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
  return h('div', { class: cx('rl-range', props.disabled && 'rl-range-off'), 'data-setting': props.setting },
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
  // trailing — кнопка внутри поля справа (смайлик выбора иконки папки, как в Telegram)
  return h('div', { class: cx('rl-tf', value && 'rl-tf-filled', err && 'rl-tf-error', props.multiline && 'rl-tf-multi', props.trailing && 'rl-tf-has-trailing', showCount && 'rl-tf-counting', (props.className || props.class)), 'data-setting': props.setting },
    h('div', { class: 'rl-tf-box' },
      h(Tag, { id: id, class: 'rl-tf-input', value: value, placeholder: ' ', maxLength: props.measure ? undefined : props.maxLength, disabled: props.disabled, rows: props.multiline ? (props.rows || 3) : undefined,
        type: props.multiline ? undefined : (props.type || 'text'), autoComplete: props.autoComplete || 'off', inputMode: props.inputMode, autoFocus: props.autoFocus,
        'aria-invalid': err ? 'true' : undefined, 'aria-describedby': err ? id + '-err' : undefined,
        onInput: function (e) { if (props.onInput) props.onInput(e.currentTarget.value, e); },
        onBlur: props.onBlur, onKeyDown: props.onKeyDown }),
      h('label', { class: 'rl-tf-label', for: id }, err || props.label),   // ошибка — прямо в подписи, как в Telegram
      showCount ? h('span', { class: cx('rl-tf-count', left <= 5 && 'rl-tf-count-low'), 'aria-hidden': 'true' }, left) : null,
      props.trailing ? h('span', { class: 'rl-tf-trailing' }, props.trailing) : null),
    h('div', { class: 'rl-tf-msg', id: id + '-err', role: 'status', 'aria-live': 'polite' }, err ? h('span', { class: 'rl-sr-only' }, err) : (props.hint || '')));
}

/* ---------- SelectRow: подпись слева, значение и ▾ справа; нативный select поверх ---------- */
function SelectRow(props) {
  var id = useId('rl-sel-', props.id);
  var opts = props.options || [];
  var cur = opts.filter(function (o) { return o.value === props.value; })[0];
  return h('div', { class: cx('rl-selrow', props.disabled && 'rl-optrow-off'), 'data-setting': props.setting },
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
  }, props.text ? h('p', { class: 'rl-mdl-text' }, props.text) : null, props.children);
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

/* ---------- ColorPicker: поле насыщенность × яркость, полоса оттенка, HEX и RGB ----------
   value — '#rrggbb'; onChange(hex) зовётся на каждом шаге перетаскивания и при вводе корректного значения.
   Оттенок хранится отдельно: на сером (s = 0) и чёрном (v = 0) он из hex не восстанавливается. */
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function hexToRgb(hex) {
  var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  var s = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function rgbToHex(rgb) { return '#' + rgb.map(function (x) { return ('0' + Math.round(x).toString(16)).slice(-2); }).join(''); }
function rgbToHsv(rgb) {
  var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255, max = Math.max(r, g, b), d = max - Math.min(r, g, b), hue = 0;
  if (d) hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue * 60, max ? d / max : 0, max];
}
function hsvToRgb(hsv) {
  var f = function (k) { var x = (k + hsv[0] / 60) % 6; return 255 * (hsv[2] - hsv[2] * hsv[1] * Math.max(0, Math.min(x, 4 - x, 1))); };
  return [f(5), f(3), f(1)];
}
function ColorPicker(props) {
  var rgb = hexToRgb(props.value) || [0, 0, 0];
  var st = useState(function () { return rgbToHsv(rgb); }), hsv = st[0], setHsv = st[1];
  // значение пришло снаружи (выбрали готовый цвет) — подстраиваемся, сохраняя оттенок на сером
  var last = useRef(props.value);
  if (props.value !== last.current && rgbToHex(hsvToRgb(hsv)) !== String(props.value).toLowerCase()) {
    var next = rgbToHsv(rgb);
    if (next[1] === 0 || next[2] === 0) next[0] = hsv[0];
    last.current = props.value;
    setHsv(next);
  }
  var hexText = useState(null), rgbText = useState(null);   // черновик ввода; null — показываем текущее
  function emit(n) { setHsv(n); var hex = rgbToHex(hsvToRgb(n)); last.current = hex; if (props.onChange) props.onChange(hex); }
  function drag(kind) {
    return function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var el = e.currentTarget, rect = el.getBoundingClientRect();
      el.setPointerCapture(e.pointerId);
      el.focus();
      var cur = hsv;
      function at(ev) {
        var x = clamp01((ev.clientX - rect.left) / rect.width), y = clamp01((ev.clientY - rect.top) / rect.height);
        cur = kind === 'hue' ? [Math.min(359.9, x * 360), cur[1], cur[2]] : [cur[0], x, 1 - y];
        emit(cur);
      }
      at(e);
      function up() { el.removeEventListener('pointermove', at); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); }
      el.addEventListener('pointermove', at);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
  }
  function keys(kind) {
    return function (e) {
      var step = e.shiftKey ? 0.1 : 0.01, n = hsv.slice(), k = e.key;
      if (kind === 'hue') {
        if (k === 'ArrowLeft' || k === 'ArrowDown') n[0] = Math.max(0, n[0] - step * 360); else if (k === 'ArrowRight' || k === 'ArrowUp') n[0] = Math.min(359.9, n[0] + step * 360); else return;
      } else if (k === 'ArrowLeft') n[1] = clamp01(n[1] - step); else if (k === 'ArrowRight') n[1] = clamp01(n[1] + step);
      else if (k === 'ArrowUp') n[2] = clamp01(n[2] + step); else if (k === 'ArrowDown') n[2] = clamp01(n[2] - step); else return;
      e.preventDefault();
      emit(n);
    };
  }
  var cur = rgbToHex(hsvToRgb(hsv)), curRgb = hsvToRgb(hsv).map(Math.round);
  var pure = 'hsl(' + Math.round(hsv[0]) + ', 100%, 50%)';
  function field(label, draft, shown, parse) {
    return h('label', { class: 'rl-cpick-field' },
      h('span', null, label),
      h('input', { type: 'text', inputMode: label === 'RGB' ? 'numeric' : 'text', spellcheck: false, autocomplete: 'off', value: draft[0] != null ? draft[0] : shown,
        onInput: function (e) { var v = e.currentTarget.value; draft[1](v); var ok = parse(v); if (ok) emit(ok); },
        onBlur: function () { draft[1](null); } }));
  }
  return h('div', { class: 'rl-cpick' },
    h('div', { class: 'rl-cpick-area', style: { backgroundColor: pure }, role: 'slider', tabIndex: 0, 'aria-label': props.label || 'Насыщенность и яркость',
      'aria-valuetext': 'насыщенность ' + Math.round(hsv[1] * 100) + '%, яркость ' + Math.round(hsv[2] * 100) + '%', onPointerDown: drag('area'), onKeyDown: keys('area') },
      h('span', { class: 'rl-cpick-thumb', style: { left: hsv[1] * 100 + '%', top: (1 - hsv[2]) * 100 + '%', background: cur } })),
    h('div', { class: 'rl-cpick-hue', role: 'slider', tabIndex: 0, 'aria-label': 'Оттенок', 'aria-valuemin': 0, 'aria-valuemax': 360, 'aria-valuenow': Math.round(hsv[0]),
      onPointerDown: drag('hue'), onKeyDown: keys('hue') },
      h('span', { class: 'rl-cpick-thumb', style: { left: hsv[0] / 360 * 100 + '%', background: pure } })),
    h('div', { class: 'rl-cpick-fields' },
      field('HEX', hexText, cur, function (v) { var x = hexToRgb(v); return x ? rgbToHsv(x) : null; }),
      field('RGB', rgbText, curRgb.join(', '), function (v) {
        var p = v.split(/[\s,;]+/).filter(Boolean).map(Number);
        return p.length === 3 && p.every(function (x) { return Number.isInteger(x) && x >= 0 && x <= 255; }) ? rgbToHsv(p) : null;
      })));
}

export { Section, RadioRow, CheckRow, RangeRow, TextField, SelectRow, ConfirmDialog, RichText, parseRich, ColorPicker, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb };
