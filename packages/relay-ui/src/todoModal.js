// Окно чек-листа — как в Telegram Web A: «Новый чек-лист» / «Изменить чек-лист» / «Добавить задачу».
//  • заголовок (до 32 символов; при добавлении задач — неизменяемый);
//  • задачи (до 64 символов): заполнили последнюю — снизу появляется пустая «Добавить задачу»; лишние пустые в конце
//    схлопываются; у каждой — ×, у заполненных — ручка: строки можно перетаскивать;
//  • подсказка «Можно добавить ещё N задач» / «Достигнут предел задач»;
//  • два переключателя (по умолчанию включены): другие могут отмечать / добавлять задачи;
//  • Enter в заголовке — к первой задаче, Enter в задаче — к пустой строке внизу; кнопка активна, когда есть
//    заголовок и хотя бы одна задача.
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon, IconButton, Switch } from './kit.js';
import { Modal } from './modal.js';

export var TODO_ITEMS_MAX = 30, TODO_TITLE_MAX = 32, TODO_ITEM_MAX = 64;
var uid = 0;
function row(title, id) { return { key: 'r' + (++uid), id: id, title: title || '' }; }

function plural(n, one, few, many) {
  var m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/** Ровно одна пустая строка в конце (пока не упёрлись в предел), хотя бы одна строка. */
function normalize(rows, room) {
  var out = rows.slice();
  while (out.length > 1 && !out[out.length - 1].title.trim() && !out[out.length - 2].title.trim()) out.pop();
  if ((!out.length || out[out.length - 1].title.trim()) && out.length < room) out.push(row(''));
  return out;
}

/**
 * props: open, mode ('create' | 'edit' | 'append'), initial (чек-лист для edit/append), onSubmit(result), onClose.
 * result: create/edit — { title, items: [{ id?, title }], othersCanAppend, othersCanComplete }; append — { items: [строки] }.
 */
export function TodoModal(props) {
  var mode = props.mode || 'create', init = props.initial;
  var existing = mode === 'append' && init ? init.items : [];
  var room = TODO_ITEMS_MAX - existing.length;
  var title = useState(init ? init.title : '');
  var rows = useState(function () {
    var start = mode === 'edit' && init ? init.items.map(function (it) { return row(it.title, it.id); }) : [];
    return normalize(start, room);
  });
  var flags = useState({ append: init ? !!init.othersCanAppend : true, complete: init ? !!init.othersCanComplete : true });
  var list = useRef(null), titleRef = useRef(null), drag = useRef(null);

  useEffect(function () {
    var t = setTimeout(function () {
      var first = mode === 'append' ? list.current && list.current.querySelector('input:not([disabled])') : titleRef.current;
      if (first) first.focus();
    }, 50);
    return function () { clearTimeout(t); };
  }, []);

  function setRow(i, text) {
    var next = rows[0].slice();
    next[i] = Object.assign({}, next[i], { title: text.slice(0, TODO_ITEM_MAX) });
    rows[1](normalize(next, room));
  }
  function remove(i) {
    var next = rows[0].filter(function (_, k) { return k !== i; });
    rows[1](normalize(next, room));
  }
  // Enter — в пустую строку внизу. Её может ещё не быть в DOM (рисуем раз в кадр) — тогда фокус переводит
  // эффект сразу после отрисовки, до того как браузер покажет кадр
  var wantLast = useRef(false);
  function focusLast() {
    var inputs = list.current ? list.current.querySelectorAll('input:not([disabled])') : [];
    var last = inputs[inputs.length - 1];
    if (last && !last.value && last !== document.activeElement) last.focus();
    else wantLast.current = true;
  }
  useLayoutEffect(function () {
    if (!wantLast.current) return;
    wantLast.current = false;
    var inputs = list.current ? list.current.querySelectorAll('input:not([disabled])') : [];
    if (inputs.length) inputs[inputs.length - 1].focus();
  }, [rows[0]]);

  var filled = rows[0].filter(function (r) { return r.title.trim(); });
  var left = room - filled.length;
  var valid = filled.length > 0 && (mode === 'append' || title[0].trim().length > 0);
  function submit() {
    if (!valid) return;
    if (mode === 'append') { props.onSubmit({ items: filled.map(function (r) { return r.title.trim(); }) }); return; }
    props.onSubmit({
      title: title[0].trim(), othersCanAppend: flags[0].append, othersCanComplete: flags[0].complete,
      items: filled.map(function (r) { return r.id != null ? { id: r.id, title: r.title.trim() } : { title: r.title.trim() }; }),
    });
  }

  // перетаскивание задач за ручку (только заполненные строки)
  function onDragStart(i, e) { drag.current = i; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch (x) { /* Firefox требует данные */ } }
  function onDragOver(i, e) {
    if (drag.current == null || drag.current === i || !rows[0][i].title.trim()) return;
    e.preventDefault();
    var next = rows[0].slice(), moved = next.splice(drag.current, 1)[0];
    next.splice(i, 0, moved);
    drag.current = i;
    rows[1](next);
  }

  var head = mode === 'edit' ? 'Изменить чек-лист' : mode === 'append' ? 'Добавить задачу' : 'Новый чек-лист';
  var action = mode === 'edit' ? 'Сохранить' : mode === 'append' ? 'Добавить' : 'Создать';
  return h(Modal, {
    open: props.open !== false, onClose: props.onClose, title: head, size: 'slim', class: 'rl-todo-modal',
    headerActions: h('button', { type: 'button', class: 'rl-todo-submit', disabled: !valid, onClick: submit }, action),
  },
    h('div', { class: 'rl-todo-sec' }, 'Заголовок'),
    h('input', { ref: titleRef, class: 'rl-todo-input rl-todo-titlein', value: title[0], maxLength: TODO_TITLE_MAX, placeholder: 'Заголовок', disabled: mode === 'append', 'aria-label': 'Заголовок чек-листа',
      onInput: function (e) { title[1](e.currentTarget.value); },
      onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); var f = list.current && list.current.querySelector('input:not([disabled])'); if (f) f.focus(); } } }),
    h('div', { class: 'rl-todo-sec' }, 'Задачи'),
    h('div', { class: 'rl-todo-list', ref: list },
      existing.map(function (it) {
        return h('div', { key: 'x' + it.id, class: 'rl-todo-row rl-todo-row-frozen' },
          h('span', { class: 'rl-todo-lead' }, h('span', { class: 'rl-todo-ring' })),
          h('input', { class: 'rl-todo-input', value: it.title, disabled: true }));
      }),
      rows[0].map(function (r, i) {
        var last = i === rows[0].length - 1 && !r.title.trim();
        return h('div', { key: r.key, class: cx('rl-todo-row', last && 'rl-todo-row-add'), onDragOver: function (e) { onDragOver(i, e); }, onDrop: function (e) { e.preventDefault(); drag.current = null; } },
          h('span', { class: 'rl-todo-lead', 'aria-hidden': 'true' }, last ? h(Icon, { name: 'plus', size: 20 }) : h('span', { class: 'rl-todo-ring' })),
          h('input', { class: 'rl-todo-input', value: r.title, maxLength: TODO_ITEM_MAX, placeholder: last ? 'Добавить задачу' : 'Задача', 'aria-label': 'Задача ' + (i + 1),
            onInput: function (e) { setRow(i, e.currentTarget.value); },
            onKeyDown: function (e) {
              if (e.key === 'Enter') { e.preventDefault(); if (e.metaKey || e.ctrlKey) submit(); else focusLast(); }
            } }),
          !last ? h('span', { class: 'rl-todo-handle', draggable: true, title: 'Перетащить', 'aria-hidden': 'true', onDragStart: function (e) { onDragStart(i, e); }, onDragEnd: function () { drag.current = null; } }, h(Icon, { name: 'menu', size: 18 })) : null,
          !last ? h(IconButton, { icon: 'close', label: 'Удалить задачу', size: 18, class: 'rl-todo-remove', onClick: function () { remove(i); } }) : null);
      })),
    h('div', { class: 'rl-todo-hint' }, left > 0 ? 'Можно добавить ещё ' + left + ' ' + plural(left, 'задачу', 'задачи', 'задач') : 'Достигнут предел задач'),
    mode !== 'append' ? h('div', { class: 'rl-todo-opts' },
      h('div', { class: 'rl-todo-opt' }, h('span', null, 'Другие могут отмечать выполненное'),
        h(Switch, { id: 'todo-complete', label: 'Другие могут отмечать выполненное', checked: flags[0].complete, onChange: function () { flags[1](Object.assign({}, flags[0], { complete: !flags[0].complete })); } })),
      h('div', { class: 'rl-todo-opt' }, h('span', null, 'Другие могут добавлять задачи'),
        h(Switch, { id: 'todo-append', label: 'Другие могут добавлять задачи', checked: flags[0].append, onChange: function () { flags[1](Object.assign({}, flags[0], { append: !flags[0].append })); } }))) : null);
}
