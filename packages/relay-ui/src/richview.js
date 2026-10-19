// Текст сообщения с оформлением — для пузырей, цитат и подписей. Строит элементы из сегментов
// (тех же, что и HTML поля ввода), без innerHTML. Подсветка поиска — внутри каждого куска.
import { Fragment, h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Highlight } from './more.js';
import { safeUrl, segments } from './richtext.js';
import { Spoiler } from './spoiler.js';

var ORDER = ['link', 'pre', 'code', 'spoiler', 'bold', 'italic', 'underline', 'strike'];

function wrap(type, value, child) {
  switch (type) {
    case 'bold': return h('b', null, child);
    case 'italic': return h('i', null, child);
    case 'underline': return h('u', null, child);
    case 'strike': return h('s', null, child);
    case 'code': return h('code', { class: 'rl-code' }, child);
    case 'pre': return h('code', { class: 'rl-pre' }, child);
    case 'spoiler': return h(Spoiler, null, child);
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

function MessageText(props) {
  var text = props.text || '', list = autoLinks(text, props.entities);
  if (!list || !list.length) return props.highlight ? h(Highlight, { text: text, query: props.highlight }) : text;
  return segments(text, list).map(function (sg, i) {
    var node = props.highlight ? h(Highlight, { text: sg.text, query: props.highlight }) : sg.text;
    for (var k = ORDER.length - 1; k >= 0; k--) {
      var t = ORDER[k];
      if (sg.marks[t]) node = wrap(t, sg.marks[t], node);
    }
    return h(Fragment, { key: i }, node);
  });
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
function ArticleBlocks(props) {
  var box = useRef(null);
  var st = useState(false), open = st[0];
  var tall = useState(false);
  useLayoutEffect(function () {
    var el = box.current;
    if (el && !open) tall[1](el.scrollHeight > ARTICLE_FOLD + 80);
  }, [props.blocks]);
  var folded = tall[0] && !open;
  return h('div', { class: 'rl-art' + (folded ? ' rl-art-folded' : '') },
    h('div', { class: 'rl-art-body', ref: box, style: folded ? { maxHeight: ARTICLE_FOLD + 'px' } : undefined }, blockNodes(props.blocks || [], props.highlight, 0)),
    folded ? h('button', { type: 'button', class: 'rl-art-more', onClick: function (e) { e.stopPropagation(); st[1](true); } }, 'Показать полностью') : null);
}

export { MessageText, ArticleBlocks };
