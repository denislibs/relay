import { h } from 'preact';
import { Bubble, DateDivider, MessageStatus, ReplyQuote, TypingIndicator, UnreadDivider, ReactionChips, SelectionBar, PollBubble, InlineKeyboard, MediaBubble, FileBubble, VoiceBubble, TodoBubble, RoundBubble } from '../src/index.js';

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

export const Buttons = {
  name: 'Кнопки под сообщением',
  render: function () {
    var rows = [
      [{ text: 'Это я', kind: 'callback', data: 'ok' }, { text: 'Завершить этот сеанс', kind: 'callback', data: 'end' }],
      [{ text: 'Завершить все остальные сеансы', kind: 'callback', data: 'others' }],
      [{ text: 'Подробнее', kind: 'url', url: 'https://example.com' }],
    ];
    var wait = function () { return new Promise(function (r) { setTimeout(r, 1500); }); };
    return h('div', { style: feed },
      h(Bubble, { from: 'in', tail: true, groupStart: true, time: '08:33', below: h(InlineKeyboard, { rows: rows, onPress: wait }) },
        'Новый вход в аккаунт\n\nУстройство: Chrome 155, macOS\nIP: 192.168.97.1'));
  },
};

// реакции как в Telegram: внутри пузыря время — последним в ряду; у медиа без подписи, стикера и кружка — снаружи
export const ReactionsEverywhere = {
  name: 'Реакции в пузырях',
  render: function () {
    var rx = [{ key: '❤', emoji: '❤', count: 2, mine: true, icon: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="%23e53935" d="M12 21s-7-4.6-9.3-8.6C.8 9 2.4 5 6.2 5c2 0 3.3 1 4.3 2.4h1C12.5 6 13.8 5 15.8 5c3.8 0 5.4 4 3.5 7.4C19 16.4 12 21 12 21z"/></svg>') }, { key: '👍', emoji: '👍', count: 1 }];
    var many = ['👍', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱'].map(function (e) { return { key: e, emoji: e, count: 1 }; });
    var avatars = [{ key: '❤', emoji: '❤', count: 2, mine: true, users: [{ name: 'Вера', tone: 2 }, { name: 'Глеб', tone: 4 }] }, { key: '👍', emoji: '👍', count: 1, users: [{ name: 'Дина', tone: 1 }] }];
    var photo = { src: '/patterns/catCafe.svg', thumb: undefined, w: 400, h: 300, kind: 'image' };
    return h('div', { style: feed },
      h(Bubble, { from: 'in', tail: true, time: '10:00', reactions: many }, 'Девять реакций: ряд переносится, время уходит на свою строку'),
      h(Bubble, { from: 'out', tail: true, time: '10:01', status: 'read', reactions: avatars }, 'Мало реакций — аватары'),
      h(MediaBubble, { from: 'in', tail: true, time: '10:02', items: [photo], ratio: '4 / 3', reactions: rx, onReact: function () {} }),
      h(MediaBubble, { from: 'out', tail: true, time: '10:03', status: 'read', items: [photo], ratio: '4 / 3', caption: 'С подписью — реакции внутри', reactions: rx, onReact: function () {} }),
      h(FileBubble, { from: 'in', tail: true, time: '10:04', name: 'Отчёт.pdf', ext: 'pdf', meta: '1,2 МБ', reactions: rx, onReact: function () {} }),
      h(VoiceBubble, { from: 'out', tail: true, time: '10:05', status: 'read', duration: 12, waveform: null, trackKey: 'sb', track: function () { return { key: 'sb', src: '', duration: 12 }; }, reactions: rx, onReact: function () {} }),
      h(TodoBubble, { from: 'in', tail: true, time: '10:06', todo: { title: 'Список', items: [{ id: 1, title: 'Купить хлеб' }, { id: 2, title: 'Позвонить' }], completions: [] }, reactions: rx, onReact: function () {} }),
      h(RoundBubble, { from: 'out', time: '10:07', status: 'read', duration: 5, reactions: rx, onReact: function () {} }));
  },
};
