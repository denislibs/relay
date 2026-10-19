import { h } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { cx, ripple, Icon } from './kit.js';

/* ---------- SearchInput: одно поле поиска на всё приложение ----------
   Таблетка во всю ширину, чуть светлее панели, без рамки; серая лупа слева.
   Фокус — кольцо и лупа цвета акцента. busy / status — лупа плавно сменяется лоадером
   (status — «Подключение…», «Обновление…» — встаёт на место плейсхолдера). Есть текст —
   справа выплывает «×». Esc: есть текст — стирает, нет — снимает фокус (и onEscape).
   back + onBack — вместо лупы стрелка «назад» (режим сброса).
   variant: 'pill' (по умолчанию) | 'plain' — без фона и кольца, для строк с «чипами».
   size: 'default' (40px) | 'compact' (36px). children — внутри поля перед вводом («чипы»).
   Значение — снаружи (value + onInput(e) или onChange(value)); «×» и Esc шлют обычное событие input,
   так что работает и тот, кто слушает только onInput. */

// Что делать по клавише: 'clear' | 'blur' | null. Отдельно — чтобы проверять без DOM.
export function searchKeyAction(key, value) {
  if (key !== 'Escape') return null;
  return value ? 'clear' : 'blur';
}

var SPIN_PATH = 'M9 2a7 7 0 1 1-7 7';

export function SearchInput(props) {
  var input = useRef(null);
  var id = props.id || 'rl-search';
  var value = props.value == null ? '' : String(props.value);
  var busy = !!(props.busy || props.status);
  var compact = props.size === 'compact';
  var iconSize = props.iconSize || (compact ? 18 : 20);
  var clearable = props.clearable !== false;
  var hasValue = value.length > 0;

  function setRef(el) {
    input.current = el;
    var r = props.inputRef;
    if (typeof r === 'function') r(el); else if (r) r.current = el;
  }

  useEffect(function () {
    if (!props.autoFocus || !input.current) return;
    // после кадра: поле могло появиться внутри выезжающей панели — без прокрутки предков
    var raf = requestAnimationFrame(function () { if (input.current) input.current.focus({ preventScroll: true }); });
    return function () { cancelAnimationFrame(raf); };
  }, []);

  function clear(refocus) {
    var el = input.current;
    if (!el) return;
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));   // onInput(e) с e.target.value === ''
    if (props.onClear) props.onClear();
    if (refocus) el.focus({ preventScroll: true });
  }

  function onInput(e) {
    if (props.onInput) props.onInput(e);
    if (props.onChange) props.onChange(e.currentTarget.value);
  }

  function onKeyDown(e) {
    if (props.onKeyDown) props.onKeyDown(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && props.onEnter && !e.isComposing) { e.preventDefault(); props.onEnter(e); return; }
    var act = searchKeyAction(e.key, e.currentTarget.value);
    if (act === 'clear') { e.preventDefault(); clear(false); }
    else if (act === 'blur') {
      if (props.onEscape) { e.preventDefault(); props.onEscape(e); }
      e.currentTarget.blur();
    }
  }

  var lead = props.icon === false ? null : props.back
    ? h('button', { type: 'button', class: 'rl-search-icon rl-search-back', 'aria-label': props.backLabel || 'Назад', onPointerDown: ripple, onClick: props.onBack },
        h(Icon, { name: 'arrowLeft', size: iconSize }))
    : h('span', { class: 'rl-search-icon', 'aria-hidden': 'true', style: { width: iconSize, height: iconSize } },
        h(Icon, { name: 'search', size: iconSize }),
        h('svg', { class: 'rl-search-spin', width: iconSize, height: iconSize, viewBox: '0 0 18 18', fill: 'none' },
          h('path', { d: SPIN_PATH, stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' })));

  var placeholder = props.status || (props.placeholder != null ? props.placeholder : 'Поиск');

  return h('div', { class: cx('rl-search', compact && 'rl-search-compact', props.variant === 'plain' && 'rl-search-plain', busy && 'rl-search-busy',
      hasValue && 'rl-search-filled', props.children && 'rl-search-chips', props.className || props.class), role: props.role, onClick: props.onClick },
    props.label !== false ? h('label', { for: id, class: 'rl-sr' }, props.label || 'Поиск') : null,
    lead,
    props.children || null,
    h('input', Object.assign({
      id: id, ref: setRef, type: 'search', value: value, placeholder: placeholder, autocomplete: 'off', spellcheck: false, enterkeyhint: 'search',
      disabled: props.disabled, onInput: onInput, onKeyDown: onKeyDown, onFocus: props.onFocus, onBlur: props.onBlur
    }, props.inputProps || {})),
    // «×» всегда в DOM: появляется и уходит переходом, без вспышки при монтировании
    clearable ? h('button', { type: 'button', class: 'rl-search-clear', 'aria-label': props.clearLabel || 'Очистить', tabIndex: hasValue ? 0 : -1, 'aria-hidden': hasValue ? undefined : 'true',
      onPointerDown: function (e) { e.preventDefault(); },   // фокус остаётся в поле
      onClick: function () { clear(true); } },
      h(Icon, { name: 'close', size: compact ? 16 : 18 })) : null,
    props.trailing || null,
    props.status ? h('span', { class: 'rl-sr', role: 'status' }, props.status) : null);
}

// Старое имя: поле поиска сайдбара. status — текст синхронизации на месте плейсхолдера.
export var SearchField = SearchInput;
