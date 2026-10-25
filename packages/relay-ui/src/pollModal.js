// Окно «Новый опрос» — по поведению Telegram (своя реализация), тем же строем, что и окно чек-листа:
//  • вопрос (до 255), варианты (до 100, 2–10): заполнили последний — снизу пустой «Добавить вариант»;
//  • переключатели: «Анонимное голосование» (по умолчанию да), «Несколько ответов», «Викторина»;
//  • у викторины — выбор правильного варианта кружком слева и необязательное пояснение (до 200);
//    «Несколько ответов» у викторины недоступно;
//  • кнопка «Создать» активна, когда есть вопрос, два варианта без повторов и (у викторины) выбран ответ.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon, IconButton, Switch } from './kit.js';
import { Modal } from './modal.js';

export var POLL_QUESTION_MAX = 255, POLL_OPTION_MAX = 100, POLL_OPTIONS_MAX = 10, POLL_SOLUTION_MAX = 200;
var uid = 0;
function row(text) { return { key: 'p' + (++uid), text: text || '' }; }
function normalize(rows) {
  var out = rows.slice();
  while (out.length > 2 && !out[out.length - 1].text.trim() && !out[out.length - 2].text.trim()) out.pop();
  if ((!out.length || out[out.length - 1].text.trim()) && out.length < POLL_OPTIONS_MAX) out.push(row(''));
  while (out.length < 2) out.push(row(''));
  return out;
}
function plural(n, one, few, many) {
  var m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/** props: open, onSubmit({ question, options, multiple, quiz, anonymous, correct?, solution? }), onClose, quiz (открыть сразу викториной). */
export function PollModal(props) {
  var q = useState('');
  var rows = useState(function () { return normalize([]); });
  var flags = useState({ anonymous: true, multiple: false, quiz: !!props.quiz });
  var correct = useState(null);   // key строки с правильным ответом
  var solution = useState('');
  var qRef = useRef(null), list = useRef(null);
  useEffect(function () { var t = setTimeout(function () { if (qRef.current) qRef.current.focus(); }, 50); return function () { clearTimeout(t); }; }, []);

  // от текущего списка, а не из замыкания: рендер — раз в кадр, и два ввода в одном кадре (автозаполнение, вставка)
  // иначе затёрли бы друг друга
  function setRow(i, text) {
    rows[1](function (cur) {
      var next = cur.slice();
      next[i] = Object.assign({}, next[i], { text: text.slice(0, POLL_OPTION_MAX) });
      return normalize(next);
    });
  }
  function remove(i) {
    var gone = rows[0][i];
    if (correct[0] === gone.key) correct[1](null);
    rows[1](function (cur) { return normalize(cur.filter(function (r) { return r.key !== gone.key; })); });
  }
  function focusNext(i) {
    var inputs = list.current ? list.current.querySelectorAll('input') : [];
    var next = inputs[i + 1];
    if (next) next.focus();
  }

  var filled = rows[0].filter(function (r) { return r.text.trim(); });
  var texts = filled.map(function (r) { return r.text.trim().toLowerCase(); });
  var dup = new Set(texts).size !== texts.length;
  var quiz = flags[0].quiz;
  var correctIdx = filled.findIndex(function (r) { return r.key === correct[0]; });
  var valid = q[0].trim().length > 0 && filled.length >= 2 && !dup && (!quiz || correctIdx >= 0);
  var left = POLL_OPTIONS_MAX - filled.length;
  function submit() {
    if (!valid) return;
    var res = { question: q[0].trim(), options: filled.map(function (r) { return r.text.trim(); }), anonymous: flags[0].anonymous, multiple: !quiz && flags[0].multiple, quiz: quiz };
    if (quiz) { res.correct = correctIdx; if (solution[0].trim()) res.solution = solution[0].trim(); }
    props.onSubmit(res);
  }
  function flip(k) {
    flags[1](function (cur) {
      var next = Object.assign({}, cur);
      next[k] = !next[k];
      if (k === 'quiz' && next.quiz) next.multiple = false;
      return next;
    });
  }

  return h(Modal, {
    open: props.open !== false, onClose: props.onClose, title: quiz ? 'Новая викторина' : 'Новый опрос', size: 'slim', class: 'rl-todo-modal rl-pollmod',
    headerActions: h('button', { type: 'button', class: 'rl-todo-submit', disabled: !valid, onClick: submit }, 'Создать'),
  },
    h('div', { class: 'rl-todo-sec' }, 'Вопрос'),
    h('input', { ref: qRef, class: 'rl-todo-input rl-todo-titlein', value: q[0], maxLength: POLL_QUESTION_MAX, placeholder: 'Задайте вопрос', 'aria-label': 'Вопрос',
      onInput: function (e) { q[1](e.currentTarget.value); },
      onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); focusNext(-1); } } }),
    h('div', { class: 'rl-todo-sec' }, 'Варианты ответа'),
    h('div', { class: 'rl-todo-list', ref: list, role: quiz ? 'radiogroup' : undefined, 'aria-label': quiz ? 'Правильный ответ' : undefined },
      rows[0].map(function (r, i) {
        var last = i === rows[0].length - 1 && !r.text.trim() && rows[0].length > 2;
        var isRight = quiz && correct[0] === r.key && r.text.trim();
        return h('div', { key: r.key, class: cx('rl-todo-row', last && 'rl-todo-row-add') },
          quiz && r.text.trim()
            ? h('button', { type: 'button', role: 'radio', 'aria-checked': String(!!isRight), 'aria-label': 'Правильный ответ: ' + r.text, class: cx('rl-pollmod-pick', isRight && 'rl-pollmod-pick-on'), onClick: function () { correct[1](r.key); } }, h(Icon, { name: 'check', size: 14, strokeWidth: 3 }))
            : h('span', { class: 'rl-todo-lead', 'aria-hidden': 'true' }, last ? h(Icon, { name: 'plus', size: 20 }) : h('span', { class: 'rl-todo-ring' })),
          h('input', { class: 'rl-todo-input', value: r.text, maxLength: POLL_OPTION_MAX, placeholder: last ? 'Добавить вариант' : 'Вариант', 'aria-label': 'Вариант ' + (i + 1),
            onInput: function (e) { setRow(i, e.currentTarget.value); },
            onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); if (e.metaKey || e.ctrlKey) submit(); else focusNext(i); } } }),
          !last && rows[0].length > 2 ? h(IconButton, { icon: 'close', label: 'Удалить вариант', size: 18, class: 'rl-todo-remove', onClick: function () { remove(i); } }) : null);
      })),
    h('div', { class: cx('rl-todo-hint', dup && 'rl-pollmod-err') },
      dup ? 'Варианты не должны повторяться'
        : quiz && filled.length >= 2 && correctIdx < 0 ? 'Отметьте правильный ответ кружком слева'
        : left > 0 ? 'Можно добавить ещё ' + left + ' ' + plural(left, 'вариант', 'варианта', 'вариантов') : 'Достигнут предел вариантов'),
    h('div', { class: 'rl-todo-opts' },
      h('div', { class: 'rl-todo-opt' }, h('span', null, 'Анонимное голосование'),
        h(Switch, { id: 'poll-anon', label: 'Анонимное голосование', checked: flags[0].anonymous, onChange: function () { flip('anonymous'); } })),
      h('div', { class: cx('rl-todo-opt', quiz && 'rl-pollmod-off') }, h('span', null, 'Несколько ответов'),
        h(Switch, { id: 'poll-multi', label: 'Несколько ответов', checked: flags[0].multiple && !quiz, disabled: quiz, onChange: function () { flip('multiple'); } })),
      h('div', { class: 'rl-todo-opt' }, h('span', null, 'Викторина'),
        h(Switch, { id: 'poll-quiz', label: 'Викторина', checked: quiz, onChange: function () { flip('quiz'); } }))),
    quiz ? h('div', null,
      h('div', { class: 'rl-todo-sec' }, 'Пояснение'),
      h('input', { class: 'rl-todo-input rl-todo-titlein', value: solution[0], maxLength: POLL_SOLUTION_MAX, placeholder: 'Покажется после ответа (необязательно)', 'aria-label': 'Пояснение',
        onInput: function (e) { solution[1](e.currentTarget.value); } })) : null);
}
