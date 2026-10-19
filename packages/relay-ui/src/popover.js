// MenuPopover — одно окно меню на всё приложение (как Menu в Telegram Web A):
//  • в портале (body): его не режут панели и не сдвигают flex-раскладки;
//  • появление — масштаб 0.85 → 1 и проявление от угла у курсора/кнопки (150 мс), исчезание — обратно (200 мс, ease-in);
//  • у точки (контекстное меню): левый верхний угол у курсора; не влезает справа — левее курсора, снизу — над ним;
//  • у кнопки: placement 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start', по вертикали переворачивается, если не влезает;
//  • header (например, реакции) — над карточкой, курсор остаётся у первого пункта;
//  • клик мимо, Esc, прокрутка окна — закрыть. hover: открыто наведением — без подложки и без фокуса на первом пункте.
import { h } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cx, reducedMotion } from './kit.js';
import { Menu } from './more.js';
import { beginHeavyAnimation } from './schedule.js';

var EXIT_MS = 200, GAP = 6, MARGIN = 8;

function place(el, p) {
  if (!el) return;
  var card = el.querySelector(':scope > .rl-menu') || el;
  var head = el.querySelector(':scope > .rl-pop-header');
  var w = card.offsetWidth, ht = card.offsetHeight;
  var hw = head ? head.offsetWidth : 0, hh = head ? head.offsetHeight + 8 : 0;
  var vw = document.documentElement.clientWidth, vh = window.innerHeight;
  var span = Math.max(w, hw);   // по ширине должны влезть и карточка, и шапка над ней
  var left, top, ox, oy;
  var a = p.anchor;
  if (a && typeof a.getBoundingClientRect === 'function') {
    var r = a.getBoundingClientRect(), pl = p.placement || 'bottom-end';
    var end = pl.slice(-3) === 'end';
    left = end ? r.right - w : r.left; ox = end ? 'right' : 'left';
    var below = r.bottom + GAP, above = r.top - GAP - ht;
    var wantTop = pl.indexOf('top') === 0;
    if (wantTop ? above >= MARGIN || below + ht > vh - MARGIN : below + ht > vh - MARGIN && above >= MARGIN) { top = above; oy = 'bottom'; }
    else { top = below; oy = 'top'; }
  } else {
    var x = a ? a.x : 0, y = a ? a.y : 0;
    if (x + span <= vw - MARGIN) { left = x; ox = 'left'; } else if (x - w >= MARGIN) { left = x - w; ox = 'right'; } else { left = vw - span - MARGIN; ox = 'left'; }
    if (y + ht <= vh - MARGIN) { top = y; oy = 'top'; } else if (y - ht >= MARGIN + hh) { top = y - ht; oy = 'bottom'; } else { top = vh - ht - MARGIN; oy = 'top'; }
  }
  left = Math.max(MARGIN, Math.min(left, vw - span - MARGIN));
  top = Math.max(MARGIN + hh, Math.min(top, vh - ht - MARGIN));
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
  card.style.transformOrigin = ox + ' ' + oy;   // анимация — на карточке (см. relay.css)
}

/**
 * props: open, anchor (Element | { x, y }), placement, onClose, items, label, header, hover, class,
 *        onPointerEnter / onPointerLeave (для меню по наведению — см. useHoverMenu).
 */
export function MenuPopover(props) {
  var open = !!props.open;
  var last = useRef(props);
  if (open) last.current = props;
  var p = open ? props : last.current;
  var st = useState(open), mounted = st[0];
  if (open && !mounted) st[1](true);
  var box = useRef(null);
  var close = useRef(null);
  close.current = props.onClose;

  useEffect(function () {
    var end = beginHeavyAnimation(open ? 160 : EXIT_MS);
    if (open) return end;
    var t = setTimeout(function () { st[1](false); }, reducedMotion() ? 0 : EXIT_MS);
    return function () { clearTimeout(t); end(); };
  }, [open]);

  useLayoutEffect(function () { if (open) place(box.current, p); }, [open, p.anchor, p.items, p.header]);

  useEffect(function () {
    if (!open) return;
    function onKey(e) { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); if (close.current) close.current(); } }
    // по наведению подложки нет: клик мимо меню и мимо кнопки — закрыть
    function onDown(e) {
      var a = props.anchor;
      if (box.current && box.current.contains(e.target)) return;
      if (a && a.contains && a.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.rl-submenu')) return;
      if (close.current) close.current();
    }
    function onResize() { if (close.current) close.current(); }
    addEventListener('keydown', onKey);
    addEventListener('resize', onResize);
    if (p.hover) document.addEventListener('pointerdown', onDown, true);
    return function () {
      removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, p.hover]);

  if (!mounted || typeof document === 'undefined') return null;
  var dismiss = function () { if (close.current) close.current(); };
  return createPortal(h('div', { class: 'rl rl-pop-root' },
    open && !p.hover ? h('div', { class: 'rl-pop-scrim', onClick: dismiss, onContextMenu: function (e) { e.preventDefault(); dismiss(); } }) : null,
    h('div', { ref: box, class: cx('rl-pop', p.class), 'data-state': open ? 'open' : 'closing',
      onPointerEnter: p.onPointerEnter, onPointerLeave: p.onPointerLeave },
      p.header ? h('div', { class: 'rl-pop-header' }, p.header) : null,
      h(Menu, { label: p.label, items: p.items, noFocus: !!p.hover, onClose: dismiss, header: p.menuHeader }))), document.body);
}

/**
 * Меню по наведению (как скрепка в Telegram): открыть через openMs после входа на кнопку, закрыть через closeMs,
 * когда мышь ушла и с кнопки, и с меню. Касанием — не открывается (только по нажатию).
 * Открытое нажатием (toggle) уходом мыши не закрывается. Возвращает обработчики для кнопки и MenuPopover и toggle().
 */
export function useHoverMenu(open, setOpen, opts) {
  var openMs = opts && opts.openMs != null ? opts.openMs : 120, closeMs = opts && opts.closeMs != null ? opts.closeMs : 250;
  var t = useRef(0), viaHover = useRef(false);
  var openRef = useRef(open); openRef.current = open;
  useEffect(function () { return function () { clearTimeout(t.current); }; }, []);
  return {
    onPointerEnter: function (e) {
      if (e && e.pointerType === 'touch') return;
      clearTimeout(t.current);
      if (!openRef.current) t.current = setTimeout(function () { viaHover.current = true; setOpen(true); }, openMs);
    },
    onPointerLeave: function (e) {
      if (e && e.pointerType === 'touch') return;
      clearTimeout(t.current);
      if (openRef.current && viaHover.current) t.current = setTimeout(function () { setOpen(false); }, closeMs);
    },
    // нажатие: открыто наведением — закрепить (уход мыши больше не закрывает), иначе переключить
    toggle: function () {
      clearTimeout(t.current);
      if (openRef.current && viaHover.current) { viaHover.current = false; return; }
      viaHover.current = false; setOpen(!openRef.current);
    },
  };
}
