import { h } from 'preact';
import { useState } from 'preact/hooks';
import { Avatar, Badge, Button, Checkbox, Chip, Fab, Icon, IconButton, Switch, Verified } from '../src/index.js';

export default { title: 'Элементы' };

var row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 };

export const Buttons = {
  name: 'Button',
  args: { children: 'Отправить', variant: 'primary', size: undefined, disabled: false, icon: undefined },
  argTypes: { variant: { control: 'select', options: ['primary', 'secondary', 'ghost', 'danger'] }, size: { control: 'select', options: [undefined, 'lg', 'tiny'] }, icon: { control: 'select', options: [undefined, 'send', 'plus', 'check'] } },
  render: function (a) { return h(Button, a); },
};

export const ButtonVariants = {
  name: 'Button — все варианты',
  render: function () {
    return h('div', { style: { display: 'grid', gap: 16 } },
      ['primary', 'secondary', 'ghost', 'danger'].map(function (v) {
        return h('div', { key: v, style: row }, h(Button, { variant: v }, v), h(Button, { variant: v, icon: 'plus' }, 'С иконкой'), h(Button, { variant: v, size: 'lg' }, 'Большая'), h(Button, { variant: v, disabled: true }, 'Неактивна'));
      }));
  },
};

export const IconButtons = {
  name: 'IconButton',
  render: function () {
    return h('div', { style: row },
      h(IconButton, { icon: 'search', label: 'Поиск' }),
      h(IconButton, { icon: 'more', label: 'Ещё' }),
      h(IconButton, { icon: 'phone', label: 'Позвонить', filled: true }),
      h(IconButton, { icon: 'bell', label: 'Уведомления', badge: 3 }),
      h(IconButton, { icon: 'star', label: 'Избранное', active: true }),
      h(IconButton, { icon: 'trash', label: 'Удалить', disabled: true }));
  },
};

export const Chips = {
  name: 'Chip и Badge',
  render: function () {
    var s = useState('all');
    return h('div', { style: { display: 'grid', gap: 16 } },
      h('div', { style: row }, [['all', 'Все', 31], ['unread', 'Непрочитанные', 4], ['groups', 'Группы', 0]].map(function (c) {
        return h(Chip, { key: c[0], active: s[0] === c[0], count: c[2] || undefined, onClick: function () { s[1](c[0]); } }, c[1]);
      })),
      h('div', { style: row }, h(Badge, { count: 1 }), h(Badge, { count: 31 }), h(Badge, { count: 1250 }), h(Badge, { count: 7, muted: true })));
  },
};

export const Toggles = {
  name: 'Switch и Checkbox',
  render: function () {
    var a = useState(true), b = useState(false);
    return h('div', { style: { display: 'grid', gap: 16, maxWidth: 360 } },
      h(Switch, { id: 'sb-sw', label: 'Звук уведомлений', checked: a[0], onChange: function (v) { a[1](typeof v === 'boolean' ? v : !a[0]); } }),
      h(Checkbox, { id: 'sb-cb', checked: b[0], onChange: function () { b[1](!b[0]); } }, 'Запомнить устройство'),
      h(Checkbox, { id: 'sb-cb2', checked: true, disabled: true }, 'Неактивный'));
  },
};

export const Avatars = {
  name: 'Avatar',
  args: { name: 'Анна Смирнова', size: 54, tone: 2, online: true },
  argTypes: { tone: { control: { type: 'range', min: 1, max: 6 } }, size: { control: { type: 'range', min: 24, max: 120, step: 2 } } },
  render: function (a) {
    return h('div', { style: { display: 'grid', gap: 20 } },
      h('div', { style: row }, h(Avatar, a), h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, a.name, h(Verified, { size: 18 }))),
      h('div', { style: row }, [1, 2, 3, 4, 5, 6].map(function (t) { return h(Avatar, { key: t, name: ['Иван Павлов', 'Мария Новикова', 'Олег', 'Полина Лебедева', 'Никита', 'Relay'][t - 1], tone: t, size: 48 }); })));
  },
};

export const FabStory = {
  name: 'Fab',
  render: function () { return h('div', { style: { position: 'relative', height: 120 } }, h(Fab, { icon: 'edit', label: 'Новый чат', onClick: function () {} })); },
};

export const IconInText = { name: 'Icon', args: { name: 'search', size: 24 }, render: function (a) { return h('span', { style: { color: 'var(--ink)' } }, h(Icon, a)); } };
