// Эмодзи картинками Apple (public/emoji/apple, см. NOTICE.md) там, где системный шрифт рисует их иначе (Windows,
// Linux, Android): в поле ввода, в пузырях, в крупных эмодзи и в полёте из поля — один рисунок везде, как на
// macOS и iOS, где тот же рисунок даёт сам шрифт (там — просто текст, глиф дешевле картинки). Так же делает tweb.
// Текст в поле по-прежнему читается из alt (richtext.readDom), смещения — в единицах UTF-16 alt.
import { h } from 'preact';

export var NATIVE_EMOJI = typeof navigator === 'undefined' || /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

var BASE = '/emoji/apple/';

// Эмодзи-последовательность: флаг (две региональные буквы), клавиша (#️⃣), или картинка (с вариантом цвета кожи)
// с цепочкой ZWJ и тегами (флаги Англии, Шотландии). Знаки, которые по умолчанию текстовые (©, ™, ↔), — только
// с селектором FE0F: без него и на macOS это буква шрифта, а не эмодзи.
var PIC = '(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)\\p{Emoji_Modifier}?';
var SEQ = '(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|' + PIC + '(?:\\u200D(?:\\p{Extended_Pictographic}\\uFE0F?\\p{Emoji_Modifier}?))*[\\u{E0020}-\\u{E007F}]*\\uFE0F?)';
export var EMOJI_RE = new RegExp(SEQ, 'gu');

/** 😀 → «1f600», 🏳️‍🌈 → «1f3f3-200d-1f308», #️⃣ → «0023-20e3»: код-пойнты через «-», без селектора fe0f. */
export function emojiFile(e) {
  var out = [];
  for (var c of e) { var hx = c.codePointAt(0).toString(16); if (hx !== 'fe0f') out.push(hx.length < 4 ? ('0000' + hx).slice(-4) : hx); }
  return out.join('-');
}
export function emojiSrc(e) { return BASE + emojiFile(e) + '.png'; }

var guarded = false;
// Картинки нет (эмодзи новее набора) — на её месте остаётся сам символ. Один слушатель на документ (error не
// всплывает — ловим на погружении), а не onerror на каждой: в поле ввода атрибуты-обработчики не нужны.
function guard() {
  if (guarded || typeof document === 'undefined') return;
  guarded = true;
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || t.nodeName !== 'IMG' || !t.classList.contains('rl-emoji') || !t.parentNode) return;
    t.parentNode.replaceChild(document.createTextNode(t.getAttribute('alt') || ''), t);
  }, true);
}

/** Есть ли что заменять картинками на этой платформе. */
export function needsEmojiImages(text) {
  if (NATIVE_EMOJI || !text) return false;
  EMOJI_RE.lastIndex = 0;
  return EMOJI_RE.test(text);
}

/** Текст → узлы Preact: строки и <img class="rl-emoji">. На macOS / iOS — сам текст. */
export function emojiNodes(text, keyBase) {
  if (!needsEmojiImages(text)) return text;
  guard();
  var out = [], last = 0, m, k = 0;
  EMOJI_RE.lastIndex = 0;
  while ((m = EMOJI_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('img', { key: (keyBase || 'e') + k++, class: 'rl-emoji', src: emojiSrc(m[0]), alt: m[0], draggable: false, decoding: 'async' }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function escAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

/** Уже экранированный HTML-текст поля → те же эмодзи картинками (для toHtml). Эмодзи не содержат &<>". */
export function emojiHtml(escaped) {
  if (!needsEmojiImages(escaped)) return escaped;
  guard();
  EMOJI_RE.lastIndex = 0;
  return escaped.replace(EMOJI_RE, function (e) { return '<img class="rl-emoji" src="' + escAttr(emojiSrc(e)) + '" alt="' + escAttr(e) + '" draggable="false">'; });
}

/**
 * Эмодзи, набранные или вставленные в поле текстом, — в картинки на месте (обход текстовых узлов). Внутри
 * неизменяемых «плашек» (contenteditable=false) не трогаем. true — DOM изменился (выделение надо вернуть).
 */
export function emojifyDom(root) {
  if (NATIVE_EMOJI || !root) return false;
  var doc = root.ownerDocument, walker = doc.createTreeWalker(root, 4), nodes = [], n;
  while ((n = walker.nextNode())) {
    if (!n.data) continue;
    EMOJI_RE.lastIndex = 0;
    if (!EMOJI_RE.test(n.data)) continue;
    var atom = n.parentNode && n.parentNode.closest ? n.parentNode.closest('[contenteditable="false"]') : null;
    if (atom && root.contains(atom)) continue;
    nodes.push(n);
  }
  if (!nodes.length) return false;
  guard();
  for (var i = 0; i < nodes.length; i++) {
    var t = nodes[i], s = t.data, frag = doc.createDocumentFragment(), last = 0, m;
    EMOJI_RE.lastIndex = 0;
    while ((m = EMOJI_RE.exec(s))) {
      if (m.index > last) frag.appendChild(doc.createTextNode(s.slice(last, m.index)));
      var img = doc.createElement('img');
      img.className = 'rl-emoji'; img.alt = m[0]; img.draggable = false; img.src = emojiSrc(m[0]);
      frag.appendChild(img);
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.appendChild(doc.createTextNode(s.slice(last)));
    t.parentNode.replaceChild(frag, t);
  }
  return true;
}
