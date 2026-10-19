import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { Banner, EmptyState, LinearProgress, ProgressRing, SyncIndicator, Toast } from '../src/index.js';

export default { title: 'Состояния' };

var col = { display: 'grid', gap: 16, maxWidth: 480 };

export const Banners = {
  name: 'Banner',
  render: function () {
    return h('div', { style: col },
      h(Banner, { icon: 'bell', action: 'Включить', onAction: function () {}, onClose: function () {} }, 'Включите уведомления, чтобы не пропускать сообщения.'),
      h(Banner, { tone: 'warn', icon: 'wifiOff' }, 'Нет сети. Сообщения уйдут, когда она появится.'),
      h(Banner, { tone: 'danger', icon: 'alert', action: 'Повторить', onAction: function () {} }, 'Не удалось синхронизировать чаты.'));
  },
};

export const Toasts = { name: 'Toast', render: function () { return h('div', { style: { position: 'relative', height: 80 } }, h(Toast, { action: 'Отменить', onAction: function () {} }, 'Чат удалён')); } };

export const Progress = {
  name: 'ProgressRing и LinearProgress',
  render: function () {
    var p = useState(0.1);
    useEffect(function () { var t = setInterval(function () { p[1](function (x) { return x >= 1 ? 0.05 : x + 0.05; }); }, 300); return function () { clearInterval(t); }; }, []);
    return h('div', { style: col },
      h('div', { style: { display: 'flex', gap: 24, alignItems: 'center' } }, h(ProgressRing, { progress: p[0], label: 'Загрузка' }), h(ProgressRing, { label: 'Ожидание' }), h(ProgressRing, { progress: p[0], size: 64, onCancel: function () {}, label: 'Загрузка' })),
      h(LinearProgress, { value: p[0], label: 'Загрузка' }),
      h(LinearProgress, { label: 'Ожидание' }));
  },
};

export const Sync = {
  name: 'SyncIndicator',
  render: function () { return h('div', { style: { display: 'flex', gap: 24 } }, ['synced', 'syncing', 'error'].map(function (s) { return h(SyncIndicator, { key: s, state: s, label: s }); })); },
};

export const Empty = {
  name: 'EmptyState',
  args: { kind: 'chats', title: 'Здесь пока пусто', text: 'Начните чат — нажмите на карандаш внизу.' },
  argTypes: { kind: { control: 'select', options: ['chats', 'search', 'contacts', 'media', 'files', 'links'] } },
  render: function (a) { return h('div', { style: { maxWidth: 400 } }, h(EmptyState, Object.assign({ key: a.kind }, a))); },
};
