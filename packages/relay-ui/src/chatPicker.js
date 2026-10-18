// ChatPicker — окно «Переслать в…» (как в Telegram Web): поиск с чипами выбранных, полоса частых собеседников,
// вкладки папок, список чатов с кружками-галочками справа. Внизу: ничего не выбрано — «Выберите чаты» (неактивна),
// один — «Переслать», несколько — поле подписи и круглая кнопка отправки.
// Клавиатура: фокус в поиске, ↑/↓ — по списку, Enter — отметить строку; Enter в поле подписи — отправить.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, ripple, Avatar, Icon, IconButton } from './kit.js';
import { FolderTabs } from './more.js';
import { Modal } from './modal.js';

/**
 * props: open, onClose, title ('Переслать в…'),
 *   chats: [{ id, title, tone, avatar?: пропсы Avatar, logo?, subtitle? }] — по порядку списка,
 *   top?: [id] — частые собеседники (полоса аватаров), folders?: [{ id, label, ids: [chatId] }] (вкладки, если их больше одной),
 *   onSend(ids, comment) — comment: текст подписи (только при нескольких чатах).
 */
export function ChatPicker(props) {
  var q = useState(''), sel = useState([]), act = useState(-1), folder = useState(null), note = useState('');
  var listRef = useRef(null), searchRef = useRef(null);
  var all = props.chats || [];
  var byId = {};
  all.forEach(function (c) { byId[c.id] = c; });
  var folders = props.folders || [];
  var f = folder[0] != null ? folders.find(function (x) { return x.id === folder[0]; }) : null;
  var needle = q[0].trim().toLowerCase();
  var list = all.filter(function (c) {
    if (f && f.ids.indexOf(c.id) < 0) return false;
    return !needle || String(c.title || '').toLowerCase().indexOf(needle) >= 0;
  });
  var picked = sel[0];

  // окно открыли заново — чистый лист
  useEffect(function () { if (props.open) { q[1](''); sel[1]([]); act[1](-1); folder[1](null); note[1](''); } }, [props.open]);
  useEffect(function () { act[1](-1); }, [needle, folder[0]]);

  function toggle(id) {
    var has = picked.indexOf(id) >= 0;
    sel[1](has ? picked.filter(function (x) { return x !== id; }) : picked.concat([id]));
    if (searchRef.current) searchRef.current.focus({ preventScroll: true });
  }
  function send() {
    if (!picked.length) return;
    props.onSend(picked.slice(), picked.length > 1 ? note[0] : '');
  }
  function moveActive(d) {
    if (!list.length) return;
    var i = act[0] < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, act[0] + d));
    act[1](i);
    var row = listRef.current && listRef.current.querySelectorAll('.rl-chatpick-row')[i];
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  function onSearchKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (act[0] >= 0 && list[act[0]]) toggle(list[act[0]].id);
      else if (list.length === 1) toggle(list[0].id);
      else send();
    } else if (e.key === 'Backspace' && !q[0] && picked.length) { e.preventDefault(); toggle(picked[picked.length - 1]); }
  }

  var top = (props.top || []).map(function (id) { return byId[id]; }).filter(Boolean);
  var activeId = act[0] >= 0 && list[act[0]] ? 'rl-chatpick-' + list[act[0]].id : undefined;

  var foot = picked.length > 1
    ? h('div', { class: 'rl-chatpick-foot rl-chatpick-foot-multi' },
        h('input', { class: 'rl-chatpick-note', type: 'text', placeholder: 'Добавить подпись…', 'aria-label': 'Подпись', value: note[0],
          onInput: function (e) { note[1](e.target.value); }, onKeyDown: function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); } } }),
        h('button', { type: 'button', class: 'rl-chatpick-send', 'aria-label': 'Переслать в ' + picked.length + ' чатов', onClick: send }, h(Icon, { name: 'send', size: 22 })))
    : h('div', { class: 'rl-chatpick-foot' },
        h('button', { type: 'button', class: 'rl-chatpick-btn', disabled: !picked.length, onClick: send }, picked.length ? 'Переслать' : 'Выберите чаты'));

  return h(Modal, { open: props.open, onClose: props.onClose, title: props.title || 'Переслать в…', size: 'slim', class: 'rl-chatpick', bodyClass: 'rl-chatpick-body' },
    h('div', { class: cx('rl-picker-head', 'rl-picker-head-multi', 'rl-chatpick-head') },
      picked.map(function (id) {
        var c = byId[id] || { title: String(id) };
        return h('button', { key: id, type: 'button', class: 'rl-picker-chip', onClick: function () { toggle(id); }, 'aria-label': 'Убрать ' + c.title },
          h('span', { class: 'rl-picker-chip-av' }, h(Avatar, Object.assign({ name: c.title, tone: c.tone, size: 32, logo: c.logo }, c.avatar || {})), h('i', { 'aria-hidden': 'true' }, h(Icon, { name: 'close', size: 18 }))),
          h('span', { class: 'rl-picker-chip-name' }, c.title));
      }),
      h('div', { class: 'rl-search rl-picker-search' },
        h('label', { for: 'rl-chatpick-q', class: 'rl-sr' }, 'Поиск чатов'),
        h('input', { id: 'rl-chatpick-q', ref: searchRef, type: 'search', 'data-autofocus': '', placeholder: picked.length ? '' : 'Поиск', autocomplete: 'off', value: q[0],
          role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'rl-chatpick-list', 'aria-activedescendant': activeId,
          onKeyDown: onSearchKey, onInput: function (e) { q[1](e.target.value); } }))),
    !needle && top.length ? h('div', { class: 'rl-chatpick-top', role: 'group', 'aria-label': 'Частые' },
      top.map(function (c) {
        var on = picked.indexOf(c.id) >= 0;
        return h('button', { key: c.id, type: 'button', class: cx('rl-chatpick-topitem', on && 'rl-picker-on'), 'aria-pressed': String(on), onClick: function () { toggle(c.id); } },
          h('span', { class: 'rl-chatpick-topav' }, h(Avatar, Object.assign({ name: c.title, tone: c.tone, size: 48, logo: c.logo }, c.avatar || {})),
            h('span', { class: 'rl-picker-check rl-chatpick-topcheck', 'aria-hidden': 'true' }, h(Icon, { name: 'check', size: 12, strokeWidth: 3 }))),
          h('span', { class: 'rl-chatpick-topname' }, String(c.title || '').split(' ')[0]));
      })) : null,
    folders.length > 1 ? h(FolderTabs, { class: 'rl-chatpick-folders', active: folder[0] == null ? folders[0].id : folder[0], items: folders,
      onChange: function (id) { folder[1](id === folders[0].id ? null : id); } }) : null,
    h('div', { class: 'rl-picker-list rl-chatpick-list', id: 'rl-chatpick-list', ref: listRef, role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Чаты' },
      list.length ? list.map(function (c, i) {
        var on = picked.indexOf(c.id) >= 0;
        return h('div', { key: c.id, id: 'rl-chatpick-' + c.id, class: cx('rl-row rl-picker-row rl-chatpick-row', on && 'rl-picker-on', i === act[0] && 'rl-chatpick-active'),
            role: 'option', 'aria-selected': String(on), onPointerDown: ripple, onClick: function () { act[1](i); toggle(c.id); } },
          h(Avatar, Object.assign({ name: c.title, tone: c.tone, size: 48, logo: c.logo }, c.avatar || {})),
          h('span', { class: 'rl-row-main' }, h('span', { class: 'rl-row-name' }, c.title), c.subtitle ? h('span', { class: 'rl-row-preview' }, c.subtitle) : null),
          h('span', { class: 'rl-picker-check', 'aria-hidden': 'true' }, h(Icon, { name: 'check', size: 14, strokeWidth: 3 })));
      }) : h('div', { class: 'rl-picker-empty' }, needle ? 'Ничего не нашли по запросу «' + q[0] + '»' : 'Здесь пока нет чатов')),
    foot);
}

/** Кнопка-стрелка «Переслать» для мест вроде шапки просмотра фото. */
export function ForwardButton(props) {
  return h(IconButton, { icon: 'forward', label: props.label || 'Переслать', onClick: props.onClick, class: props.class });
}
