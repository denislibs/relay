// Текст сообщения с оформлением — для пузырей, цитат и подписей. Строит элементы из сегментов
// (тех же, что и HTML поля ввода), без innerHTML. Подсветка поиска — внутри каждого куска.
import { Fragment, h } from 'preact';
import { useState } from 'preact/hooks';
import { cx } from './kit.js';
import { Highlight } from './more.js';
import { safeUrl, segments } from './richtext.js';

var ORDER = ['link', 'pre', 'code', 'spoiler', 'bold', 'italic', 'underline', 'strike'];

function Spoiler(props) {
  var open = useState(false);
  // скрытое открывается по клику и остаётся открытым; клик не уходит дальше (лента не реагирует)
  return h('span', {
    class: cx('rl-spoiler', open[0] && 'rl-spoiler-open'), role: open[0] ? undefined : 'button', tabIndex: open[0] ? undefined : 0,
    'aria-label': open[0] ? undefined : 'Скрытый текст, нажмите, чтобы показать',
    onClick: function (e) { if (!open[0]) { e.preventDefault(); e.stopPropagation(); open[1](true); } },
    onKeyDown: function (e) { if (!open[0] && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open[1](true); } },
  }, h('span', { class: 'rl-spoiler-text', 'aria-hidden': open[0] ? undefined : 'true' }, props.children));
}

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
function MessageText(props) {
  var text = props.text || '', list = props.entities;
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

export { MessageText };
