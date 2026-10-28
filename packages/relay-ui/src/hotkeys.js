// Горячие клавиши приложения: один слушатель на окно, сочетания строкой ('mod+shift+f', 'alt+arrowup').
// Поведение — по образцу Telegram Web (не код):
//  • mod — ⌘ на Apple, Ctrl на остальных; модификаторы сверяются точно (лишний Shift — уже другое сочетание);
//  • буква сверяется по напечатанному символу, а если раскладка не латинская (русская и т. п.) — по физической
//    клавише (e.code), так ⌘F работает и на «⌘А»; цифры — всегда по e.code (Shift их меняет);
//  • не мешаем: IME (isComposing), уже обработанным событиям, открытым модальным окнам и меню;
//  • в полях ввода срабатывают только сочетания с ⌘/Ctrl или Alt (буквы там — текст), если не сказано иначе.

export var IS_APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

var MODS = ['mod', 'ctrl', 'meta', 'alt', 'shift'];

/** 'mod+Shift+F' → { ctrl, meta, alt, shift, key } для этой платформы. */
export function parseCombo(combo, apple) {
  if (apple === undefined) apple = IS_APPLE;
  var parts = String(combo).toLowerCase().split('+').map(function (s) { return s.trim(); });
  var key = parts.pop() || '+';   // 'mod++' — плюс
  if (key === '' && parts.length) key = '+';
  var c = { ctrl: false, meta: false, alt: false, shift: false, key: key };
  parts.forEach(function (m) {
    if (m === 'mod') { if (apple) c.meta = true; else c.ctrl = true; }
    else if (MODS.indexOf(m) >= 0) c[m] = true;
  });
  return c;
}

var LATIN = /^[a-z]$/;

/** Нажатая клавиша в терминах сочетаний: 'f', '1', 'arrowup', 'escape', 'pageup'… */
function keysOf(e) {
  var out = [];
  var k = (e.key || '').toLowerCase();
  var code = e.code || '';
  if (/^Digit[0-9]$/.test(code)) return [code.slice(5)];
  if (/^Numpad[0-9]$/.test(code)) return [code.slice(6)];
  if (k) out.push(k === ' ' ? 'space' : k);
  // не латинская буква без AltGr/Option (ими печатают символы) — сверяем по физической клавише
  if (/^Key[A-Z]$/.test(code) && !LATIN.test(k) && !e.altKey && !(e.getModifierState && e.getModifierState('AltGraph'))) out.push(code.slice(3).toLowerCase());
  if (code === 'Equal' || code === 'NumpadAdd') out.push('+', '=');
  if (code === 'Minus' || code === 'NumpadSubtract') out.push('-');
  return out;
}

export function matchCombo(e, combo, apple) {
  var c = typeof combo === 'string' ? parseCombo(combo, apple) : combo;
  if (!!e.ctrlKey !== c.ctrl || !!e.metaKey !== c.meta || !!e.altKey !== c.alt) return false;
  // у '+' Shift не сверяем: на большинстве раскладок '+' и есть Shift+'='
  if (c.key !== '+' && !!e.shiftKey !== c.shift) return false;
  return keysOf(e).indexOf(c.key) >= 0;
}

function isTextTarget(t) {
  return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}
function overlayOpen() {
  return typeof document !== 'undefined' && !!document.querySelector('[aria-modal="true"], [role="menu"], .rl-viewer, .rl-scrim');
}

var layers = [];   // { map: [{ combo, run, opts }], parsed }
var listening = false;

function onKey(e) {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
  var inText = isTextTarget(e.target) || isTextTarget(document.activeElement);
  var overlay = overlayOpen();
  // новее — раньше: открытый позже экран перехватывает своё сочетание первым
  for (var i = layers.length - 1; i >= 0; i--) {
    var L = layers[i];
    for (var j = 0; j < L.length; j++) {
      var b = L[j];
      if (!matchCombo(e, b.parsed)) continue;
      if (overlay && !b.opts.overlay) continue;
      if (inText && !(b.opts.inText !== undefined ? b.opts.inText : b.parsed.ctrl || b.parsed.meta || b.parsed.alt)) continue;
      if (e.repeat && !b.opts.repeat) { e.preventDefault(); return; }
      if (b.run(e) === false) continue;   // false — «не моё», пусть попробует следующий
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
}

/**
 * Регистрирует сочетания; возвращает функцию снятия.
 * bindings: { 'mod+f': fn, … } или [[combo, fn, opts]]; opts: { inText, overlay, repeat }.
 * Обработчик, вернувший false, пропускает событие дальше.
 */
export function addHotkeys(bindings, opts) {
  opts = opts || {};
  var list = Array.isArray(bindings) ? bindings : Object.keys(bindings).map(function (k) { return [k, bindings[k]]; });
  var layer = list.map(function (x) { return { combo: x[0], run: x[1], opts: Object.assign({}, opts, x[2] || {}), parsed: parseCombo(x[0]) }; });
  layers.push(layer);
  if (!listening && typeof window !== 'undefined') { window.addEventListener('keydown', onKey); listening = true; }
  return function () {
    var i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    if (!layers.length && listening) { window.removeEventListener('keydown', onKey); listening = false; }
  };
}

/* ---------- подписи для людей: ⌘ ⇧ ⌥ на Apple, Ctrl Shift Alt на остальных ---------- */
var NAMES = {
  enter: ['↵', 'Enter'], escape: ['Esc', 'Esc'], space: ['Пробел', 'Пробел'], backspace: ['⌫', 'Backspace'], tab: ['⇥', 'Tab'],
  arrowup: ['↑', '↑'], arrowdown: ['↓', '↓'], arrowleft: ['←', '←'], arrowright: ['→', '→'],
  pageup: ['PageUp', 'PageUp'], pagedown: ['PageDown', 'PageDown'], home: ['Home', 'Home'], end: ['End', 'End'],
};

/** 'mod+shift+x' → ['⌘', '⇧', 'X'] (или ['Ctrl', 'Shift', 'X']) — по клавише на чип. */
export function comboKeys(combo, apple) {
  if (apple === undefined) apple = IS_APPLE;
  var parts = String(combo).toLowerCase().split('+');
  var key = parts.pop() || '+';
  if (key === '' && parts.length) key = '+';
  var out = [];
  parts.forEach(function (m) {
    if (m === 'mod') out.push(apple ? '⌘' : 'Ctrl');
    else if (m === 'ctrl') out.push(apple ? '⌃' : 'Ctrl');
    else if (m === 'meta') out.push(apple ? '⌘' : 'Win');
    else if (m === 'alt') out.push(apple ? '⌥' : 'Alt');
    else if (m === 'shift') out.push(apple ? '⇧' : 'Shift');
  });
  var n = NAMES[key];
  out.push(n ? n[apple ? 0 : 1] : key.length === 1 ? key.toUpperCase() : key);
  return out;
}

/** Строкой — для подсказок и title: '⌘⇧X' на Apple, 'Ctrl+Shift+X' на остальных. */
export function comboLabel(combo, apple) {
  if (apple === undefined) apple = IS_APPLE;
  return comboKeys(combo, apple).join(apple ? '' : '+');
}
