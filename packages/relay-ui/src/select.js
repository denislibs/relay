// SelectField — поле-список в стиле полей ввода (подпись на рамке) со своим выпадающим списком вместо системного:
// стеклянная плашка как у меню, отмеченный пункт с галочкой, к нему прокручено при открытии.
// Клавиатура: ↑/↓/Enter/Пробел открывают и выбирают, Home/End, буквы — переход к пункту, Esc/Tab — закрыть.
// Фокус остаётся на кнопке поля (aria-activedescendant) — ловушки фокуса модалок не мешают.
import { h } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon } from './kit.js';

var seq = 0;
var GAP = 6, MAX_H = 320;

export function SelectField(props) {
  var opts = props.options || [];
  var idRef = useRef(null);
  if (!idRef.current) idRef.current = props.id || 'rl-select-' + (++seq);
  var id = idRef.current;
  var openSt = useState(false), open = openSt[0];
  var actSt = useState(-1), active = actSt[0];
  var posSt = useState(null), pos = posSt[0];
  var btn = useRef(null), list = useRef(null), typed = useRef({ s: '', t: 0 });
  // быстрые нажатия (зажатая стрелка) приходят раньше перерисовки — состояние читаем из ссылок, а не из замыкания
  var openRef = useRef(false), actRef = useRef(-1);
  function setOpen(v) { openRef.current = v; openSt[1](v); }
  function setAct(v) { actRef.current = typeof v === 'function' ? v(actRef.current) : v; actSt[1](actRef.current); }
  var cur = Math.max(0, opts.findIndex(function (o) { return o.value === props.value; }));

  function place() {
    var r = btn.current.getBoundingClientRect();
    var below = innerHeight - r.bottom - GAP - 8, above = r.top - GAP - 8;
    var up = below < Math.min(MAX_H, opts.length * 40 + 8) && above > below;
    posSt[1]({ left: Math.min(r.left, innerWidth - Math.max(r.width, 160) - 8), width: r.width, top: up ? null : r.bottom + GAP, bottom: up ? innerHeight - r.top + GAP : null, max: Math.min(MAX_H, up ? above : below), up: up });
  }
  function show() { if (props.disabled || openRef.current) return; place(); setAct(cur); setOpen(true); }
  function hide() { setOpen(false); }
  function pick(i) { var o = opts[i]; hide(); if (o && o.value !== props.value && props.onChange) props.onChange(o.value); }

  // отмеченный — в середину списка при открытии; активный при стрелках — в поле зрения
  useLayoutEffect(function () {
    if (!open || !list.current) return;
    var el = list.current.querySelector('[data-i="' + active + '"]');
    if (el) el.scrollIntoView({ block: active === cur && !list.current.dataset.moved ? 'center' : 'nearest' });
  }, [open, active]);
  // клик мимо, прокрутка страницы, изменение размера — закрыть
  useEffect(function () {
    if (!open) return;
    var down = function (e) { if (!list.current || list.current.contains(e.target) || btn.current.contains(e.target)) return; hide(); };
    var away = function (e) { if (list.current && list.current.contains(e.target)) return; hide(); };
    document.addEventListener('pointerdown', down, true);
    addEventListener('resize', hide);
    addEventListener('scroll', away, true);
    return function () { document.removeEventListener('pointerdown', down, true); removeEventListener('resize', hide); removeEventListener('scroll', away, true); };
  }, [open]);

  function onKey(e) {
    var k = e.key, last = opts.length - 1;
    if (!openRef.current) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); show(); }
      return;
    }
    if (list.current) list.current.dataset.moved = '1';
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }
    else if (k === 'Tab') hide();
    else if (k === 'ArrowDown') { e.preventDefault(); setAct(function (a) { return Math.min(last, a + 1); }); }
    else if (k === 'ArrowUp') { e.preventDefault(); setAct(function (a) { return Math.max(0, a - 1); }); }
    else if (k === 'Home') { e.preventDefault(); setAct(0); }
    else if (k === 'End') { e.preventDefault(); setAct(last); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(actRef.current); }
    else if (k.length === 1) {
      // набор букв — к первому подходящему пункту (как в системных списках)
      var now = Date.now(), t = typed.current;
      t.s = (now - t.t > 700 ? '' : t.s) + k.toLowerCase(); t.t = now;
      var i = opts.findIndex(function (o) { return String(o.label).toLowerCase().indexOf(t.s) === 0; });
      if (i >= 0) setAct(i);
    }
  }

  var popover = open && pos ? createPortal(
    h('div', { ref: list, id: id + '-list', role: 'listbox', 'aria-labelledby': id + '-label', 'data-esc-layer': '',
      class: cx('rl-select-pop', pos.up && 'rl-select-up'),
      style: { left: pos.left + 'px', minWidth: pos.width + 'px', maxHeight: pos.max + 'px', top: pos.top != null ? pos.top + 'px' : 'auto', bottom: pos.bottom != null ? pos.bottom + 'px' : 'auto' } },
      opts.map(function (o, i) {
        var sel = i === cur;
        return h('div', { key: String(o.value), id: id + '-o' + i, 'data-i': i, role: 'option', 'aria-selected': sel ? 'true' : 'false',
          class: cx('rl-select-opt', i === active && 'is-active', sel && 'is-selected'),
          onPointerDown: function (e) { e.preventDefault(); },   // фокус остаётся на поле
          onPointerMove: function () { if (actRef.current !== i) setAct(i); },
          onClick: function () { pick(i); } },
          h('span', { class: 'rl-select-check', 'aria-hidden': 'true' }, sel ? h(Icon, { name: 'check', size: 18 }) : null),
          h('span', null, o.label));
      })), document.body) : null;

  return h('div', { class: cx('rl-tf rl-tf-filled rl-tf-select', open && 'is-open', props.class || props.className) },
    h('div', { class: 'rl-tf-box' },
      h('button', { ref: btn, id: id, type: 'button', class: 'rl-tf-input rl-select-btn', disabled: props.disabled,
        'aria-haspopup': 'listbox', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': open ? id + '-list' : undefined,
        'aria-activedescendant': open && active >= 0 ? id + '-o' + active : undefined, 'aria-labelledby': id + '-label ' + id,
        onClick: function () { openRef.current ? hide() : show(); }, onKeyDown: onKey, onBlur: function () { setTimeout(function () { if (document.activeElement !== btn.current) hide(); }, 0); } },
        h('span', { class: 'rl-select-value' }, opts[cur] ? opts[cur].label : ''),
        h('span', { class: 'rl-select-chev', 'aria-hidden': 'true' }, h(Icon, { name: 'chevronDown', size: 20 }))),
      h('label', { id: id + '-label', class: 'rl-tf-label', for: id }, props.label)),
    popover);
}
