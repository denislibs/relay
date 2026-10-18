// Текст сообщения с оформлением — для пузырей, цитат и подписей. Строит элементы из сегментов
// (тех же, что и HTML поля ввода), без innerHTML. Подсветка поиска — внутри каждого куска.
import { Fragment, h } from 'preact';
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
