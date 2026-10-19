import { h } from 'preact';
import { useState } from 'preact/hooks';
import { ArchivedRow, ChatRow, ChatRowSkeleton, FolderTabs, FolderRail } from '../src/index.js';

export default { title: 'Список чатов', parameters: { surface: 'raised' } };

var box = { maxWidth: 400 };

export const Row = {
  name: 'ChatRow',
  args: { name: 'Анна Смирнова', preview: 'Скинь, пожалуйста, фото с выходных', time: '10:05', unread: 3, status: undefined, avatarTone: 2, pinned: false, muted: false, active: false, online: true, typing: '', draft: '', mentioned: false, verified: false },
  argTypes: { status: { control: 'select', options: [undefined, 'pending', 'sent', 'delivered', 'read', 'failed'] }, avatarTone: { control: { type: 'range', min: 1, max: 6 } } },
  render: function (a) { return h('div', { style: box }, h(ChatRow, Object.assign({}, a, { typing: a.typing || undefined, draft: a.draft || undefined }))); },
};

export const Variants = {
  name: 'ChatRow — варианты',
  render: function () {
    var act = useState(1);
    var rows = [
      { name: 'Избранное', preview: 'Ссылка на макет', time: 'Вчера', pinned: true, avatarTone: 5 },
      { name: 'Иван Павлов', preview: 'Ок, договорились', time: '10:05', status: 'read', avatarTone: 1, online: true },
      { name: 'Работа', author: 'Мария', preview: 'Созвон в 15:00', time: '09:41', unread: 12, avatarTone: 3, mentioned: true },
      { name: 'Новости', preview: 'Вышло обновление 2.4', time: 'пн', unread: 128, muted: true, avatarTone: 4, verified: true },
      { name: 'Полина', preview: '', time: '08:12', typing: 'печатает', avatarTone: 6 },
      { name: 'Никита', preview: 'Привет!', time: '07.10.2026', draft: 'Сейчас посмотрю', avatarTone: 2 },
      { name: 'Олег', preview: 'Не доставлено', time: '00:01', status: 'failed', avatarTone: 1 },
    ];
    return h('div', { style: box },
      h(ArchivedRow, { count: 4, label: 'Архив' }),
      rows.map(function (r, i) { return h(ChatRow, Object.assign({ key: i, active: act[0] === i, onClick: function () { act[1](i); } }, r)); }));
  },
};

export const Skeleton = { name: 'ChatRowSkeleton', render: function () { return h('div', { style: box }, [0, 1, 2, 3, 4].map(function (i) { return h(ChatRowSkeleton, { key: i }); })); } };

var folders = [{ id: 'all', label: 'Все', count: 31 }, { id: 'personal', label: 'Личные', count: 4 }, { id: 'work', label: 'Работа' }, { id: 'news', label: 'Новости', count: 128, muted: true }, { id: 'bots', label: 'Боты' }];

export const Tabs = {
  name: 'FolderTabs',
  render: function () {
    var a = useState('all');
    return h('div', { style: box }, h(FolderTabs, { label: 'Папки', active: a[0], items: folders, onChange: a[1] }));
  },
};

export const Rail = {
  name: 'FolderRail',
  render: function () {
    var a = useState('all');
    return h('div', { style: { height: 420, width: 80 } }, h(FolderRail, { label: 'Папки', active: a[0], items: folders.map(function (f) { return Object.assign({ icon: 'folder' }, f); }), onChange: a[1] }));
  },
};
