// Модалки: один слой поверх всего приложения (как #portals в Telegram Web A) и стек открытых окон.
//  • <Modal open onClose title …> — декларативно: содержимое рендерится порталом в слой, поэтому окно
//    не заперто в колонке, где его объявили (подложка всегда на весь экран), а хуки и контекст — от вызывающего.
//  • openModal((close) => …, opts) — сервис: открыть окно из любого места кода (не из рендера), вернёт { close, update }.
//  • confirmModal({ title, text, confirm, danger }) → Promise<boolean> — диалог подтверждения как сервис.
//  • <ModalRoot /> — один раз в корне приложения: рисует окна, открытые через сервис.
// Esc и клик по подложке закрывают только верхнее окно; Tab не выходит за него; фокус возвращается туда,
// где был. Закрытие анимируется (окно живёт ещё exitMs), при reduced motion — сразу.
import { h } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon, IconButton, reducedMotion } from './kit.js';
import { beginHeavyAnimation } from './schedule.js';

var EXIT_MS = 200;
var layer = null;

/** Слой модалок в body. rl-dialog-host — его видит «заслонка» экрана (screenBlur) и делает inert. */
function getLayer() {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = 'rl rl-modal-layer rl-dialog-host';
  document.body.appendChild(layer);
  return layer;
}

/* ---------- стек: верхнее окно получает Esc и держит фокус ---------- */
var stack = [];   // { id, ref: { onClose, closeOnEsc }, el: () => HTMLElement }
var nextId = 1;

var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function onKey(e) {
  var top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    if (e.defaultPrevented) return;   // Esc уже съело что-то внутри окна (меню, поле с подсказками)
    e.preventDefault(); e.stopPropagation();
    if (top.ref.current.closeOnEsc !== false && top.ref.current.onClose) top.ref.current.onClose();
    return;
  }
  if (e.key !== 'Tab') return;
  var root = top.el();
  if (!root) return;
  var list = Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null || n === document.activeElement; });
  if (!list.length) { e.preventDefault(); root.focus(); return; }
  var i = list.indexOf(document.activeElement);
  if (i < 0 || (!e.shiftKey && i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
  else if (e.shiftKey && i === 0) { e.preventDefault(); list[list.length - 1].focus(); }
}

function push(entry) {
  if (!stack.length) window.addEventListener('keydown', onKey, true);
  stack.push(entry);
}
function pull(id) {
  stack = stack.filter(function (x) { return x.id !== id; });
  if (!stack.length) window.removeEventListener('keydown', onKey, true);
}

/** Сколько окон открыто (например, чтобы глобальные хоткеи не срабатывали под модалкой). */
export function modalOpen() { return stack.length > 0; }

/* ---------- окно ---------- */
function Dialog(props) {
  var p = props.p, ref = props.cbRef;
  var dialogRef = useRef(null);
  var titleId = useRef('rl-mdl-t' + nextId++).current;
  // в стек — на время жизни окна в состоянии «открыто»
  useLayoutEffect(function () {
    if (!props.open) return undefined;
    var id = nextId++, prev = document.activeElement;
    push({ id: id, ref: ref, el: function () { return dialogRef.current; } });
    // фокус: [autofocus] / первое поле, иначе само окно (кнопка «закрыть» не должна загораться кольцом)
    var root = dialogRef.current;
    if (root && !root.contains(document.activeElement)) {
      var auto = root.querySelector('[autofocus], [data-autofocus], input:not([type]), input[type=text], input[type=password], input[type=search], input[type=tel], input[type=email], textarea');
      (auto || root).focus({ preventScroll: true });
    }
    return function () {
      pull(id);
      if (prev && prev.focus && document.contains(prev) && (!document.activeElement || document.activeElement === document.body || (dialogRef.current && dialogRef.current.contains(document.activeElement)))) prev.focus({ preventScroll: true });
    };
  }, [props.open]);

  var size = p.size || 'default';
  var header = p.header !== undefined ? p.header : (p.title != null || p.onClose || p.onBack) ? h('div', { class: 'rl-mdl-head' },
    p.onBack ? h(IconButton, { icon: 'arrowLeft', label: 'Назад', onClick: p.onBack })
      : p.onClose && p.closeButton !== false ? h(IconButton, { icon: 'close', label: 'Закрыть', onClick: p.onClose }) : null,
    p.title != null ? h('h2', { class: 'rl-mdl-title', id: titleId }, p.title) : null,
    p.headerActions ? h('div', { class: 'rl-mdl-head-actions' }, p.headerActions) : null) : null;

  // окно убрали из дерева, пока оно было открыто ({x ? <Modal/> : null}) — оставляем в слое неживую
  // копию на время анимации закрытия, чтобы не было резкого исчезновения
  var rootRef = useRef(null), openRef = useRef(props.open);
  openRef.current = props.open;
  useLayoutEffect(function () {
    return function () {
      var el = rootRef.current;
      if (!el || !openRef.current || reducedMotion()) return;
      var ghost = el.cloneNode(true);
      ghost.classList.remove('rl-mdl-open'); ghost.classList.add('rl-mdl-closing');
      ghost.setAttribute('inert', ''); ghost.setAttribute('aria-hidden', 'true');
      getLayer().appendChild(ghost);
      setTimeout(function () { ghost.remove(); }, EXIT_MS);
    };
  }, []);

  return h('div', { ref: rootRef, class: cx('rl-mdl', props.open ? 'rl-mdl-open' : 'rl-mdl-closing'), style: { zIndex: props.z } },
    h('div', { class: 'rl-mdl-backdrop', 'aria-hidden': 'true', onClick: function () { if (p.closeOnBackdrop !== false && p.onClose) p.onClose(); } }),
    h('div', {
      ref: dialogRef, tabIndex: -1, role: p.role || 'dialog', 'aria-modal': 'true',
      'aria-labelledby': p.title != null && !p.label ? titleId : undefined, 'aria-label': p.label,
      class: cx('rl-mdl-dialog', typeof size === 'string' && 'rl-mdl-' + size, (p.className || p.class)),
      style: typeof size === 'number' ? { width: size + 'px' } : undefined,
    },
      header,
      p.icon ? h('div', { class: 'rl-mdl-hero' }, h(Icon, { name: p.icon, size: 64, strokeWidth: 1.4 })) : null,
      h('div', { class: cx('rl-mdl-body', p.bodyClass) }, p.children),
      p.actions ? h('div', { class: 'rl-mdl-actions' }, p.actions) : null));
}

var zSeq = 0;
/**
 * Модальное окно. props: open (по умолчанию true), onClose, title, label (если заголовка нет),
 * size ('narrow' 320 | 'confirm' 384 | 'slim' 420 | 'default' 560 — как в Telegram Web A | число px), onBack (стрелка вместо крестика),
 * headerActions, header (свой заголовок; null — без него), icon (большая иконка над текстом),
 * actions (кнопки внизу справа), closeOnBackdrop, closeOnEsc, class, bodyClass, role.
 */
export function Modal(props) {
  var open = props.open !== false;
  var cbRef = useRef(props);
  cbRef.current = props;
  var st = useState(open), mounted = st[0], setMounted = st[1];
  var z = useRef(0);
  if (open && !mounted) setMounted(true);
  if (open && !z.current) z.current = ++zSeq;   // позже открытое — выше
  useEffect(function () {
    var end = beginHeavyAnimation(open ? 260 : EXIT_MS);
    if (open) return end;
    var t = setTimeout(function () { setMounted(false); z.current = 0; }, reducedMotion() ? 0 : EXIT_MS);
    return function () { clearTimeout(t); end(); };
  }, [open]);
  if (!mounted || typeof document === 'undefined') return null;
  return createPortal(h(Dialog, { p: props, cbRef: cbRef, open: open, z: z.current }), getLayer());
}

/* ---------- сервис ---------- */
var service = [];   // { id, render, opts, open }
var listeners = new Set();
function emit() { listeners.forEach(function (fn) { fn(); }); }

/**
 * Открыть окно из кода: render(close) → содержимое; opts — пропсы Modal (title, size, actions можно
 * отдать функцией (close) => …). Возвращает { close, update(render) }. Нужен смонтированный <ModalRoot/>.
 */
export function openModal(render, opts) {
  var id = nextId++;
  var item = { id: id, render: render, opts: opts || {}, open: true };
  function close() {
    if (!item.open) return;
    item.open = false; emit();
    setTimeout(function () { service = service.filter(function (x) { return x !== item; }); emit(); }, reducedMotion() ? 0 : EXIT_MS + 20);
    if (item.opts.onClose) item.opts.onClose();
  }
  item.close = close;
  service = service.concat([item]); emit();
  return { close: close, update: function (r) { item.render = r; service = service.slice(); emit(); } };
}

/** Подтверждение как сервис: resolve(true) — «да», false — отмена/Esc/подложка. */
export function confirmModal(o) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(v, close) { if (done) return; done = true; resolve(v); close(); }
    var m = openModal(function (close) {
      return o.text ? h('p', { class: 'rl-mdl-text' }, o.text) : null;
    }, {
      title: o.title, size: 'confirm', role: 'alertdialog', closeButton: false, class: 'rl-mdl-confirm',
      onClose: function () { if (!done) { done = true; resolve(false); } },
      actions: function (close) {
        return [
          h('button', { key: 'c', type: 'button', class: 'rl-mdl-btn', 'data-autofocus': o.danger ? '' : undefined, onClick: function () { finish(false, close); } }, o.cancel || 'Отмена'),
          h('button', { key: 'o', type: 'button', class: cx('rl-mdl-btn', o.danger && 'rl-mdl-btn-danger'), 'data-autofocus': o.danger ? undefined : '', onClick: function () { finish(true, close); } }, o.confirm || 'Ок'),
        ];
      },
    });
    return m;
  });
}

/** Корень сервиса — смонтировать один раз (в App). */
export function ModalRoot() {
  var st = useState(0), force = st[1];
  useEffect(function () {
    function fn() { force(function (n) { return n + 1; }); }
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }, []);
  return h('div', { hidden: true }, service.map(function (item) {
    var o = item.opts;
    return h(Modal, Object.assign({}, o, {
      key: item.id, open: item.open, onClose: item.close,
      actions: typeof o.actions === 'function' ? o.actions(item.close) : o.actions,
    }), item.render(item.close));
  }));
}
