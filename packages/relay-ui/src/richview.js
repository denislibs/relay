// Текст сообщения с оформлением — для пузырей, цитат и подписей. Строит элементы из сегментов
// (тех же, что и HTML поля ввода), без innerHTML. Подсветка поиска — внутри каждого куска.
import { Fragment, h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { beginHeavyAnimation, forceMeasure, requestMeasure, requestMutation } from './schedule.js';
import { Icon, reducedMotion } from './kit.js';
import { Highlight } from './more.js';
import { codeFromPlain, safeUrl, segments } from './richtext.js';
import { emojiNodes } from './emojiImg.js';
import { Spoiler } from './spoiler.js';
import { FormattedDate } from './dateView.js';

/** Тост «Дата скопирована» — приложение подставляет свой показ (setDateCopiedToast). */
var dateCopied = null;
export function setDateCopiedToast(fn) { dateCopied = fn; }
/** Клик по @имени в тексте — приложение открывает человека, группу или канал (setMentionOpener). */
var mentionOpen = null;
export function setMentionOpener(fn) { mentionOpen = fn; }

var ORDER = ['link', 'mention', 'date', 'pre', 'code', 'spoiler', 'bold', 'italic', 'underline', 'strike'];

function wrap(type, value, child) {
  switch (type) {
    case 'bold': return h('b', null, child);
    case 'italic': return h('i', null, child);
    case 'underline': return h('u', null, child);
    case 'strike': return h('s', null, child);
    case 'code': return h('code', { class: 'rl-code' }, child);
    case 'pre': return h('code', { class: 'rl-pre' }, child);
    case 'spoiler': return h(Spoiler, null, child);
    case 'date': return h(FormattedDate, { value: value, onCopied: dateCopied }, child);
    case 'link': {
      var url = safeUrl(value);
      if (!url) return child;
      return h('a', { class: 'rl-link', href: url, target: '_blank', rel: 'noopener noreferrer', onClick: function (e) { e.stopPropagation(); } }, child);
    }
  }
  return child;
}

/** { text, entities, highlight? } → элементы. Без сущностей — просто текст (дешёвый путь). */
/* Адреса в тексте — ссылками, как в Telegram (http(s)://… и www.…): если их не покрывает оформление ссылкой или кодом */
var URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'«»]+/gi;
function autoLinks(text, list) {
  if (text.indexOf('http') < 0 && text.indexOf('www.') < 0) return list;
  var out = list ? list.slice() : [], m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    var raw = m[0].replace(/[.,!?:;)\]}»"']+$/, ''), from = m.index, to = from + raw.length;
    var taken = out.some(function (e) { return (e.type === 'link' || e.type === 'code' || e.type === 'pre') && e.offset < to && e.offset + e.length > from; });
    if (!taken && raw) out.push({ type: 'link', offset: from, length: raw.length, url: /^www\./i.test(raw) ? 'https://' + raw : raw });
  }
  return out;
}

/* @имя — ссылкой, как в Telegram (то же правило, что MENTION_RE в protocol: 5–32 знака, не внутри слова, почты и
   адреса); внутри ссылки, кода и блока кода — просто текст */
var MENTION_RE = /(?<![\p{L}\p{N}_@./])@[A-Za-z][A-Za-z0-9_]{4,31}(?![\p{L}\p{N}_])/gu;
function autoMentions(text, list) {
  if (text.indexOf('@') < 0) return list;
  var out = list ? list.slice() : [], m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text))) {
    var from = m.index, to = from + m[0].length;
    var taken = out.some(function (e) { return (e.type === 'link' || e.type === 'code' || e.type === 'pre') && e.offset < to && e.offset + e.length > from; });
    if (!taken) out.push({ type: 'mention', offset: from, length: m[0].length });
  }
  return out;
}
function mentionLink(name, child) {
  return h('a', { class: 'rl-link rl-mention-link', href: '#', onClick: function (e) { e.preventDefault(); e.stopPropagation(); if (mentionOpen) mentionOpen(name); } }, child);
}

/* ---------- цитата в тексте (blockquote) ----------
   Текст в DOM остаётся дословно текстом сообщения (выделение, смещения): перевод строки вплотную к блоку лежит в скрытом
   узле. Свёрнутая высота задана CSS с первого кадра и не зависит от замеров: короткая цитата просто в неё помещается, поэтому
   решение «нужна ли кнопка» (замер в фазе measure, только спорные случаи) высоту строки не меняет — лента не прыгает. */
var QUOTE_LINES = 3, QUOTE_MS = 260;
var quoteOpen = new Map();   // развёрнутые цитаты: за строкой, пока она в памяти (окно ленты размонтирует строки)
function rememberQuote(key, open) {
  if (key == null) return;
  quoteOpen.delete(key);
  if (open) { quoteOpen.set(key, true); if (quoteOpen.size > 1000) quoteOpen.delete(quoteOpen.keys().next().value); }
}
/** Длиннее ли цитата трёх строк — по данным, без раскладки: true / false — ясно; null — нужно мерить (зависит от ширины). */
export function quoteTall(text) {
  var lines = text.split('\n');
  if (lines.length > QUOTE_LINES) return true;
  return lines.length + text.length / 18 <= QUOTE_LINES ? false : null;
}
// один наблюдатель на все спорные цитаты: первый вызов — сразу после раскладки, дальше — только при смене ширины
var quoteRo = null, quoteWatch = new WeakMap();
function watchQuote(el, fn) {
  if (typeof ResizeObserver === 'undefined') return function () {};
  if (!quoteRo) quoteRo = new ResizeObserver(function (list) {
    for (var i = 0; i < list.length; i++) { var cb = quoteWatch.get(list[i].target); if (cb) cb(); }
  });
  quoteWatch.set(el, fn);
  quoteRo.observe(el);
  return function () { quoteRo.unobserve(el); quoteWatch.delete(el); };
}

function QuoteBlock(props) {
  var collapsible = !!props.collapsed, key = props.scope != null ? props.scope + ':' + props.offset : null;
  var guess = collapsible ? quoteTall(props.text) : false;
  var st = useState(function () { return collapsible && key != null && quoteOpen.has(key); }), open = collapsible && st[0];
  var fs = useState(open || guess === true), fold = fs[0];
  var box = useRef(null), run = useRef(0);
  useEffect(function () {
    if (!collapsible) return;
    if (guess !== null) { if (fold !== (guess || open)) fs[1](guess || open); return; }
    if (open) return;
    return watchQuote(box.current, function () {
      requestMeasure(function () {
        var el = box.current;
        if (!el) return;
        var over = el.scrollHeight > el.clientHeight + 1;
        requestMutation(function () { fs[1](over); });
      });
    });
  }, [collapsible, guess, open]);
  function toggle() {
    var next = !st[0], id = ++run.current;
    rememberQuote(key, next);
    requestMeasure(function () {
      var el = box.current;
      if (!el) return;
      var from = el.getBoundingClientRect().height, line = parseFloat(getComputedStyle(el).lineHeight) || 20;
      var to = next ? el.scrollHeight : Math.min(el.scrollHeight, line * QUOTE_LINES);
      // лента решает, что держать на месте (Feed: низ у прижатой ленты и у цитаты, торчащей за верх); чтение — здесь, в фазе замера
      var detail = { adjust: null, done: null };
      el.dispatchEvent(new CustomEvent('rl-quote-resize', { bubbles: true, detail: detail }));
      requestMutation(function () {
        el.style.maxHeight = from + 'px';
        st[1](next);
        if (reducedMotion() || document.hidden) { el.style.maxHeight = ''; if (detail.adjust) detail.adjust(to - from); if (detail.done) detail.done(); return; }
        beginHeavyAnimation(QUOTE_MS + 40);
        var t0 = performance.now();
        // высота и прокрутка — одной записью в кадр и без чтений: конечное значение уже известно, раскладку считает только браузер
        (function frame(now) {
          if (run.current !== id) { if (detail.done) detail.done(); return; }
          var t = Math.min(1, Math.max(0, (now - t0) / QUOTE_MS)), e = 1 - Math.pow(1 - t, 3), hh = from + (to - from) * e;
          el.style.maxHeight = t < 1 ? hh + 'px' : '';
          if (detail.adjust) detail.adjust(hh - from);
          if (t < 1) requestAnimationFrame(frame); else if (detail.done) detail.done();
        })(t0);
      });
    });
  }
  function onClick(e) {
    // свёрнутая разворачивается по клику, кроме своих кликов содержимого: ссылка, спойлер, код, дата. Идёт выделение и выбор сообщений — тоже нет
    var t = e.target;
    if (t.closest('a, button, code, .rl-spoiler:not(.rl-spoiler-open), .rl-msgline-select') || String(getSelection() || '')) return;
    toggle();
  }
  return h('span', { class: 'rl-bq' + (collapsible ? ' rl-bq-collapsible' : '') + (fold ? ' rl-bq-fold' : '') + (open ? ' rl-bq-open' : ''), role: 'blockquote', 'data-collapsed': collapsible ? '1' : undefined,
      onClick: fold && !open ? onClick : undefined },
    h(Icon, { name: 'quote', size: 14, class: 'rl-bq-icon' }),
    h('span', { class: 'rl-bq-body', ref: box }, props.children),
    fold ? h('button', { type: 'button', class: 'rl-bq-toggle', 'aria-expanded': String(open), 'aria-label': open ? 'Свернуть цитату' : 'Развернуть цитату', onClick: function (e) { e.stopPropagation(); toggle(); } }, h(Icon, { name: 'chevronDown', size: 16 })) : null);
}

function MessageText(props) {
  var text = props.text || '', ents = props.entities;
  var plain = codeFromPlain(text, ents);
  if (plain) { text = plain.text; ents = plain.entities; }
  var list = autoMentions(text, autoLinks(text, ents));
  if (!list || !list.length) return props.highlight ? h(Highlight, { text: text, query: props.highlight }) : emojiNodes(text);
  function inline(sg, str, i) {
    var node = props.highlight ? h(Highlight, { text: str, query: props.highlight }) : emojiNodes(str, i + ':');
    for (var k = ORDER.length - 1; k >= 0; k--) {
      var t = ORDER[k];
      if (sg.marks[t]) node = t === 'mention' ? mentionLink(sg.text.slice(1), node) : wrap(t, sg.marks[t], node);
    }
    return h(Fragment, { key: i }, node);
  }
  var segs = segments(text, list), quotes = list.filter(function (e) { return e.type === 'blockquote'; });
  if (!quotes.length) return segs.map(function (sg, i) { return inline(sg, sg.text, i); });
  var out = [], q = 0;
  for (var i = 0; i < segs.length; i++) {
    var sg = segs[i];
    if (!sg.marks.blockquote) {
      var str = sg.text;
      var prevQuote = i > 0 && segs[i - 1].marks.blockquote, nextQuote = i + 1 < segs.length && segs[i + 1].marks.blockquote;
      if (prevQuote && str[0] === '\n') { out.push(h('span', { key: 'a' + i, class: 'rl-bq-nl' }, '\n')); str = str.slice(1); }
      var tail = nextQuote && str[str.length - 1] === '\n';
      if (tail) str = str.slice(0, -1);
      if (str) out.push(inline(sg, str, i));
      if (tail) out.push(h('span', { key: 'b' + i, class: 'rl-bq-nl' }, '\n'));
      continue;
    }
    var en = quotes[q++], kids = [];
    while (i < segs.length && segs[i].marks.blockquote) { kids.push(inline(segs[i], segs[i].text, i)); i++; }
    i--;
    out.push(h(QuoteBlock, { key: 'q' + en.offset, text: text.slice(en.offset, en.offset + en.length), offset: en.offset, collapsed: en.collapsed, scope: props.scope }, kids));
  }
  return out;
}

/* ---------- ArticleBlocks: «статья» в пузыре ----------
   Блоки: абзац, заголовок 1–3, маркированный/нумерованный список (вложенные), цитата, код (с языком), разделитель.
   Текст блоков — тот же MessageText (ссылки, спойлеры, код в строке). Длинная статья свёрнута с затуханием и
   кнопкой «Показать полностью», как в Telegram. */
var ARTICLE_FOLD = 520;   // выше этого (px) — сворачиваем
function blockNodes(list, hl, depth) {
  return list.map(function (b, i) {
    switch (b.type) {
      case 'p': return h('p', { key: i, class: 'rl-art-p' }, b.text ? h(MessageText, { text: b.text, entities: b.entities, highlight: hl }) : h('br'));
      case 'h': return h('h' + (b.level + 2), { key: i, class: 'rl-art-h rl-art-h' + b.level }, h(MessageText, { text: b.text, entities: b.entities, highlight: hl }));
      case 'ul': return h('ul', { key: i, class: 'rl-art-list' }, b.items.map(function (it, k) { return h('li', { key: k }, blockNodes(it, hl, depth + 1)); }));
      case 'ol': return h('ol', { key: i, class: 'rl-art-list', start: b.start || undefined }, b.items.map(function (it, k) { return h('li', { key: k }, blockNodes(it, hl, depth + 1)); }));
      case 'quote': return h('blockquote', { key: i, class: 'rl-art-quote' }, blockNodes(b.blocks, hl, depth + 1));
      case 'code': return h('div', { key: i, class: 'rl-art-code' },
        b.lang ? h('span', { class: 'rl-art-code-lang' }, b.lang) : null,
        h('pre', null, h('code', null, b.text)));
      case 'hr': return h('hr', { key: i, class: 'rl-art-hr' });
    }
    return null;
  });
}
/**
 * Длинная ли статья — по данным, без раскладки, когда ответ ясен: снизу строк не меньше, чем абзацев, пунктов и
 * переносов; сверху — как если бы в строку влезало всего 20 символов. true / false — ясно; null — нужно мерить.
 */
export function articleTall(list) {
  var lines = 0, chars = 0, blocks = 0, code = 0;
  (function walk(bs) {
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i]; blocks++;
      if (b.type === 'p' || b.type === 'h' || b.type === 'code') { var t = b.text || ''; lines += 1 + (t.match(/\n/g) || []).length; chars += t.length; if (b.type === 'code') code++; }
      else if (b.type === 'ul' || b.type === 'ol') { for (var k = 0; k < b.items.length; k++) walk(b.items[k]); }
      else if (b.type === 'quote') walk(b.blocks || []);
      else lines += 1;
    }
  })(list || []);
  var limit = ARTICLE_FOLD + 80;
  if (lines * 20 + blocks * 4 > limit) return true;               // даже по одной строке на абзац — выше порога
  if ((lines + chars / 20) * 30 + blocks * 24 + code * 32 <= limit) return false;   // даже узко, крупно и с полями — ниже
  return null;
}

function ArticleBlocks(props) {
  var box = useRef(null);
  var st = useState(false), open = st[0];
  var guess = articleTall(props.blocks);
  var tall = useState(guess === true);
  // спорный случай — одно чтение до отрисовки (осознанное исключение: иначе кадр с развёрнутой статьёй и прыжок
  // ленты); ясный — решён по данным, раскладка не нужна
  useLayoutEffect(function () {
    if (open) return;
    if (guess !== null) { if (tall[0] !== guess) tall[1](guess); return; }
    var el = box.current;
    if (el) forceMeasure(function () { tall[1](el.scrollHeight > ARTICLE_FOLD + 80); });
  }, [props.blocks]);
  var folded = tall[0] && !open;
  return h('div', { class: 'rl-art' + (folded ? ' rl-art-folded' : '') },
    h('div', { class: 'rl-art-body', ref: box, style: folded ? { maxHeight: ARTICLE_FOLD + 'px' } : undefined }, blockNodes(props.blocks || [], props.highlight, 0)),
    folded ? h('button', { type: 'button', class: 'rl-art-more', onClick: function (e) { e.stopPropagation(); st[1](true); } }, 'Показать полностью') : null);
}

export { MessageText, ArticleBlocks };
