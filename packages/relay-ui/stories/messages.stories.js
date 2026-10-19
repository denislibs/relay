import { h } from 'preact';
import { Bubble, DateDivider, MessageStatus, ReplyQuote, TypingIndicator, UnreadDivider, ReactionChips, SelectionBar, PollBubble } from '../src/index.js';

export default { title: 'Сообщения', parameters: { surface: 'page' } };

var feed = { display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 560 };

export const Message = {
  name: 'Bubble',
  args: { from: 'in', children: 'Привет! Как дела? Посмотри макет, когда будет минутка.', time: '10:05', status: 'read', author: '', authorTone: 2, tail: true, edited: false, deleted: false },
  argTypes: { from: { control: 'inline-radio', options: ['in', 'out'] }, status: { control: 'select', options: [undefined, 'pending', 'sent', 'delivered', 'read', 'failed'] }, authorTone: { control: { type: 'range', min: 1, max: 6 } } },
  render: function (a) { return h('div', { style: feed }, h(Bubble, Object.assign({}, a, { author: a.author || undefined }))); },
};

export const Conversation = {
  name: 'Переписка',
  render: function () {
    return h('div', { style: feed },
      h(DateDivider, null, 'Вчера'),
      h(Bubble, { from: 'in', author: 'Мария', authorTone: 3, groupStart: true, time: '21:40' }, 'Кто завтра на созвон?'),
      h(Bubble, { from: 'in', tail: true, time: '21:41', reactions: [{ emoji: '👍', count: 2, mine: true }, { emoji: '🔥', count: 1 }] }, 'Начинаем в 15:00'),
      h(UnreadDivider, { count: 3 }),
      h(Bubble, { from: 'out', groupStart: true, time: '21:45', status: 'read', reply: { author: 'Мария', text: 'Начинаем в 15:00', tone: 3 } }, 'Я буду'),
      h(Bubble, { from: 'out', tail: true, time: '21:46', status: 'delivered', edited: true }, 'Только на 10 минут опоздаю'),
      h(Bubble, { from: 'out', tail: true, time: '21:47', status: 'pending' }, 'Отправляется…'),
      h(Bubble, { from: 'out', tail: true, time: '21:48', status: 'failed' }, 'Не отправилось'),
      h(Bubble, { from: 'in', tail: true, time: '21:50', deleted: true }),
      h('div', { style: { alignSelf: 'flex-start' } }, h(TypingIndicator, { who: 'Мария' })));
  },
};

export const Statuses = {
  name: 'MessageStatus',
  render: function () {
    return h('div', { style: { display: 'flex', gap: 24, alignItems: 'center', color: 'var(--ink-muted)' } },
      ['pending', 'sent', 'delivered', 'read', 'failed'].map(function (s) { return h('span', { key: s, style: { display: 'grid', justifyItems: 'center', gap: 6, fontSize: 12 } }, h(MessageStatus, { status: s, size: 18 }), s); }));
  },
};

export const Quote = {
  name: 'ReplyQuote',
  render: function () {
    return h('div', { style: { display: 'grid', gap: 12, maxWidth: 420 } },
      [1, 2, 3, 4, 5, 6].map(function (t) { return h(ReplyQuote, { key: t, author: 'Автор ' + t, text: 'Цитата сообщения, на которое отвечаем', tone: t, onCancel: t === 1 ? function () {} : undefined }); }));
  },
};

export const Reactions = { name: 'ReactionChips', render: function () { return h(ReactionChips, { items: [{ emoji: '❤️', count: 12, mine: true }, { emoji: '😂', count: 3 }, { emoji: '👀', count: 1 }] }); } };

export const Poll = {
  name: 'PollBubble',
  render: function () {
    return h('div', { style: feed }, h(PollBubble, { from: 'in', tail: true, author: 'Олег', authorTone: 1, time: '12:00', question: 'Куда идём в пятницу?', options: [{ text: 'Кино', votes: 4 }, { text: 'Бар', votes: 7 }, { text: 'Домой', votes: 1 }], onVote: function () {} }));
  },
};

export const Selection = { name: 'SelectionBar', render: function () { return h('div', { style: { maxWidth: 560 } }, h(SelectionBar, { count: 3, onCancel: function () {}, onCopy: function () {}, onForward: function () {}, onDelete: function () {}, onStar: function () {} })); } };
