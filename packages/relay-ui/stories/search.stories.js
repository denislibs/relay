import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { SearchInput, ChatSearchBar, SidebarHeader } from '../src/index.js';

export default { title: 'Поиск' };

function Controlled(props) {
  var v = useState(props.value || '');
  return h(SearchInput, Object.assign({}, props, { value: v[0], onChange: v[1] }));
}

/** Одно поле поиска на всё приложение. Попробуйте: фокус, ввод (появится «×»), Esc. */
export const Playground = {
  name: 'SearchInput',
  args: { id: 'sb-q', placeholder: 'Поиск', value: '', busy: false, status: '', size: 'default', variant: 'pill', clearable: true, back: false, disabled: false },
  argTypes: { size: { control: 'inline-radio', options: ['default', 'compact'] }, variant: { control: 'inline-radio', options: ['pill', 'plain'] } },
  render: function (a) {
    return h('div', { style: { maxWidth: 420 } }, h(Controlled, Object.assign({}, a, { key: a.value, status: a.status || undefined, onBack: function () {} })));
  },
};

export const States = {
  name: 'SearchInput — состояния',
  render: function () {
    var col = { display: 'grid', gap: 16, maxWidth: 420 };
    return h('div', { style: col },
      h(Controlled, { id: 'sb-s1', placeholder: 'Поиск' }),
      h(Controlled, { id: 'sb-s2', value: 'Анна' }),
      h(Controlled, { id: 'sb-s3', value: 'при', busy: true }),
      h(Controlled, { id: 'sb-s4', status: 'Обновление…' }),
      h(Controlled, { id: 'sb-s5', placeholder: 'Компактное', size: 'compact' }),
      h(Controlled, { id: 'sb-s6', placeholder: 'С кнопкой «назад»', back: true, onBack: function () {} }),
      h(Controlled, { id: 'sb-s7', placeholder: 'Без фона (plain)', variant: 'plain' }));
  },
};

/** Лоадер плавно сменяет лупу и обратно. */
export const BusyToggle = {
  name: 'SearchInput — лоадер',
  render: function () {
    var b = useState(false);
    useEffect(function () { var t = setInterval(function () { b[1](function (x) { return !x; }); }, 1500); return function () { clearInterval(t); }; }, []);
    return h('div', { style: { maxWidth: 420 } }, h(Controlled, { id: 'sb-busy', value: 'музыка', busy: b[0] }));
  },
};

export const WithChips = {
  name: 'SearchInput — с чипами',
  render: function () {
    var items = useState(['Контакты', 'Иван Павлов', 'Работа']), q = useState('');
    return h('div', { style: { maxWidth: 420 } },
      h(SearchInput, { id: 'sb-chips', icon: !items[0].length, value: q[0], onChange: q[1], placeholder: items[0].length ? '' : 'Поиск чатов',
        onKeyDown: function (e) { if (e.key === 'Backspace' && !q[0] && items[0].length) { e.preventDefault(); items[1](items[0].slice(0, -1)); } } },
        items[0].map(function (c) {
          return h('button', { key: c, type: 'button', class: 'rl-chip', style: { height: 30 }, onClick: function () { items[1](items[0].filter(function (x) { return x !== c; })); } }, c + ' ×');
        })));
  },
};

export const InChat = {
  name: 'ChatSearchBar',
  render: function () {
    var q = useState('');
    return h('div', { style: { maxWidth: 640 } }, h(ChatSearchBar, { id: 'sb-cs', value: q[0], onQuery: q[1], total: q[0] ? 3 : 0, onNext: function () {}, onPrev: function () {}, onClose: function () { q[1](''); } }));
  },
};

export const Sidebar = {
  name: 'SidebarHeader',
  render: function () {
    var q = useState(''), open = useState(false);
    return h('div', { style: { maxWidth: 400, background: 'var(--raised)', borderRadius: 20 } },
      h(SidebarHeader, { searchId: 'sb-side', value: q[0], back: open[0], onBack: function () { open[1](false); q[1](''); }, onMenu: function () {},
        onSearch: function (e) { q[1](e.target.value); open[1](true); }, onSearchFocus: function () { open[1](true); } }));
  },
};
