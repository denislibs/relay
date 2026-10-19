import { h } from 'preact';
import { useState } from 'preact/hooks';
import { CheckRow, InfoRow, PanelHeader, RadioRow, RangeRow, Section, SelectRow, TextField } from '../src/index.js';

export default { title: 'Настройки', parameters: { surface: 'page' } };

var page = { maxWidth: 420, display: 'grid', gap: 12 };

export const Rows = {
  name: 'Section и InfoRow',
  render: function () {
    return h('div', { style: page },
      h(PanelHeader, { icon: 'arrowLeft', title: 'Настройки', onClose: function () {} }),
      h(Section, { title: 'Аккаунт' },
        h(InfoRow, { tile: 'blue', icon: 'user', title: 'Мой профиль', subtitle: 'Имя, фото, о себе', onClick: function () {} }),
        h(InfoRow, { tile: 'green', icon: 'bell', title: 'Уведомления', value: 'Вкл', onClick: function () {} }),
        h(InfoRow, { tile: 'gray', icon: 'folder', title: 'Папки с чатами', count: 3, onClick: function () {} }),
        h(InfoRow, { icon: 'trash', title: 'Удалить аккаунт', danger: true, onClick: function () {} })));
  },
};

export const Choices = {
  name: 'RadioRow, CheckRow, RangeRow, SelectRow',
  render: function () {
    var r = useState('auto'), c = useState(true), v = useState(16), s = useState('ru');
    return h('div', { style: page },
      h(Section, { title: 'Тема' }, [['light', 'Светлая'], ['dark', 'Тёмная'], ['auto', 'Как в системе']].map(function (o) {
        return h(RadioRow, { key: o[0], title: o[1], checked: r[0] === o[0], onChange: function () { r[1](o[0]); } });
      })),
      h(Section, { title: 'Чаты' },
        h(CheckRow, { title: 'Отправка по Enter', subtitle: 'Shift+Enter — новая строка', checked: c[0], onChange: function () { c[1](!c[0]); } }),
        h(RangeRow, { id: 'sb-range', label: 'Размер текста', min: 12, max: 24, step: 1, value: v[0], onChange: v[1], format: function (x) { return x + ' px'; } }),
        h(SelectRow, { id: 'sb-sel', label: 'Язык', value: s[0], onChange: s[1], options: [{ value: 'ru', label: 'Русский' }, { value: 'en', label: 'English' }] })));
  },
};

export const Fields = {
  name: 'TextField',
  render: function () {
    var a = useState('Анна'), b = useState('');
    return h('div', { style: Object.assign({}, page, { background: 'var(--raised)', padding: 16, borderRadius: 16 }) },
      h(TextField, { id: 'sb-tf1', label: 'Имя', value: a[0], onInput: a[1] }),
      h(TextField, { id: 'sb-tf2', label: 'О себе', value: b[0], onInput: b[1], multiline: true, counter: true, maxLength: 70, hint: 'Пара слов о себе' }),
      h(TextField, { id: 'sb-tf3', label: 'Имя пользователя', value: 'ab', onInput: function () {}, error: 'Минимум 5 символов' }));
  },
};
