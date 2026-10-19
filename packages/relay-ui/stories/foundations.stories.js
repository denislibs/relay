import { h } from 'preact';
import tokens from '../tokens.json';
import { Icon, ICONS, RelayLogo } from '../src/index.js';

export default { title: 'Основы' };

var cell = { display: 'grid', gap: 6, fontSize: 12, color: 'var(--ink-muted)' };

/** Цветовые токены из tokens.json: квадрат показывает значение текущей темы (переключатель «Тема» сверху). */
export const Colors = {
  name: 'Цвета',
  render: function () {
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 } },
      tokens.color.tokens.map(function (t) {
        return h('div', { key: t.name, style: cell },
          h('div', { style: { height: 56, borderRadius: 12, background: 'var(--' + t.name + ')', boxShadow: 'inset 0 0 0 1px var(--line)' } }),
          h('b', { style: { color: 'var(--ink)', fontSize: 13 } }, '--' + t.name),
          h('span', null, (t.value.light || '') + ' / ' + (t.value.dark || '')),
          t.usage ? h('span', null, t.usage) : null);
      }));
  },
};

export const Icons = {
  name: 'Иконки',
  args: { size: 24 },
  argTypes: { size: { control: { type: 'range', min: 12, max: 48, step: 2 } } },
  render: function (a) {
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 12, color: 'var(--ink)' } },
      Object.keys(ICONS).map(function (n) {
        return h('div', { key: n, style: Object.assign({}, cell, { justifyItems: 'center', textAlign: 'center' }) },
          h(Icon, { name: n, size: a.size }), h('span', null, n));
      }));
  },
};

export const Logo = { name: 'Логотип', args: { size: 96 }, render: function (a) { return h(RelayLogo, a); } };

export const Type = {
  name: 'Шрифт',
  render: function () {
    var sizes = [[28, 600], [22, 600], [17, 500], [15, 400], [14, 400], [13, 400], [12, 400]];
    return h('div', { style: { display: 'grid', gap: 12 } }, sizes.map(function (s) {
      return h('div', { key: s[0], style: { font: s[1] + ' ' + s[0] + 'px/1.3 var(--font-sans)' } }, s[0] + 'px · ' + s[1] + ' — Съешь же ещё этих мягких французских булок');
    }));
  },
};
