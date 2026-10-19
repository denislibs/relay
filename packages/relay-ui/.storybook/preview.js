import { h } from 'preact';
import '../tokens.css';
import '../relay.css';

// Тема — как в приложении: data-theme на <html>; «Система» — по prefers-color-scheme.
function withTheme(Story, ctx) {
  var t = ctx.globals.theme;
  var root = document.documentElement;
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
  root.dataset.anim = ctx.globals.motion === 'off' ? '0' : '1';
  return h('div', { class: 'sb-relay', style: { minHeight: '100vh', padding: ctx.parameters.layout === 'fullscreen' ? 0 : 24, boxSizing: 'border-box', background: 'var(--' + (ctx.parameters.surface || 'panel') + ')', color: 'var(--ink)', fontFamily: 'var(--font-sans)' } }, h(Story));
}

export default {
  decorators: [withTheme],
  globalTypes: {
    theme: { description: 'Тема', toolbar: { title: 'Тема', icon: 'contrast', items: [{ value: 'light', title: 'Светлая' }, { value: 'dark', title: 'Тёмная' }, { value: 'system', title: 'Системная' }], dynamicTitle: true } },
    motion: { description: 'Анимации', toolbar: { title: 'Анимации', icon: 'play', items: [{ value: 'on', title: 'Анимации вкл' }, { value: 'off', title: 'Анимации выкл' }], dynamicTitle: true } },
  },
  initialGlobals: { theme: 'dark', motion: 'on' },
  parameters: {
    layout: 'padded',
    options: { storySort: { order: ['Основы', 'Элементы', 'Поиск', 'Список чатов', 'Сообщения', 'Состояния', 'Окна', 'Настройки'] } },
    backgrounds: { disable: true },
    controls: { expanded: true, matchers: { color: /(background|color)$/i } },
  },
};
