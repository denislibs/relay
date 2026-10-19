import { h } from 'preact';
import { useState } from 'preact/hooks';
import { Button, ChatPicker, ConfirmDialog, ContactPicker, Menu, Modal, Tooltip } from '../src/index.js';

export default { title: 'Окна' };

var people = ['Алексей Егоров', 'Алина Алексеева', 'Иван Павлов', 'Мария Новикова', 'Никита Смирнов', 'Олег Козлов', 'Полина Лебедева'].map(function (n, i) {
  return { id: i + 1, name: n, tone: (i % 6) + 1, about: i % 3 ? 'был(а) недавно' : 'в сети', online: !(i % 3) };
});

export const Dialog = {
  name: 'Modal',
  render: function () {
    var o = useState(false);
    return h('div', null, h(Button, { onClick: function () { o[1](true); } }, 'Открыть окно'),
      h(Modal, { open: o[0], onClose: function () { o[1](false); }, title: 'Заголовок окна', size: 'slim' }, h('p', { style: { padding: '0 20px 20px', margin: 0 } }, 'Содержимое. Закрывается по Esc, крестику и подложке.')));
  },
};

export const Confirm = {
  name: 'ConfirmDialog',
  render: function () {
    var o = useState(false);
    return h('div', null, h(Button, { variant: 'danger', onClick: function () { o[1](true); } }, 'Удалить чат'),
      h(ConfirmDialog, { open: o[0], title: 'Удалить чат?', text: 'Сообщения пропадут у вас. Отменить нельзя.', confirm: 'Удалить', danger: true, onConfirm: function () { o[1](false); }, onCancel: function () { o[1](false); } }));
  },
};

export const ContextMenu = {
  name: 'Menu',
  render: function () {
    var o = useState(null);
    return h('div', null, h(Button, { variant: 'secondary', onClick: function (e) { var r = e.currentTarget.getBoundingClientRect(); o[1]({ x: r.left, y: r.bottom + 6 }); } }, 'Открыть меню'),
      o[0] ? h(Menu, { label: 'Действия', x: o[0].x, y: o[0].y, onClose: function () { o[1](null); }, items: [
        { icon: 'reply', label: 'Ответить', onClick: function () {} }, { icon: 'copy', label: 'Копировать', onClick: function () {} },
        { icon: 'forward', label: 'Переслать', onClick: function () {} }, { icon: 'trash', label: 'Удалить', danger: true, onClick: function () {} }] }) : null);
  },
};

export const Contacts = {
  name: 'ContactPicker',
  args: { multi: false },
  render: function (a) {
    return h('div', { style: { maxWidth: 400, height: 480, display: 'flex', flexDirection: 'column', background: 'var(--raised)', borderRadius: 20, paddingTop: 12 } },
      h(ContactPicker, { key: String(a.multi), multi: a.multi, contacts: people, placeholder: a.multi ? 'Кого добавить?' : 'Имя или номер', onPick: function () {} }));
  },
};

export const Forward = {
  name: 'ChatPicker («Переслать в…»)',
  render: function () {
    var o = useState(false);
    var chats = people.map(function (p) { return { id: p.id, title: p.name, tone: p.tone, subtitle: p.about }; });
    return h('div', null, h(Button, { onClick: function () { o[1](true); } }, 'Переслать'),
      h(ChatPicker, { open: o[0], onClose: function () { o[1](false); }, chats: chats, top: [1, 3, 4, 6, 7], folders: [{ id: 'all', label: 'Все', ids: chats.map(function (c) { return c.id; }) }, { id: 'f', label: 'Друзья', ids: [1, 3, 5] }], onSend: function () { o[1](false); } }));
  },
};

export const Hint = { name: 'Tooltip', render: function () { return h('div', { style: { padding: 40 } }, h(Tooltip, { text: 'Подсказка' }, h(Button, { variant: 'secondary' }, 'Наведите'))); } };
