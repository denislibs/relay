// Пузырь чек-листа — как в Telegram Web A:
//  заголовок и подпись («Ваш чек-лист» / «Чек-лист Анны» / «Общий чек-лист», пересланный — просто «Чек-лист»);
//  задачи с круглыми флажками; в общем списке у отмеченной задачи из-за флажка выезжает аватар отметившего,
//  под задачей — его имя; только для чтения (пересланный или чужой без права отмечать) — точка или галочка,
//  выполненное зачёркнуто; внизу — «N из M выполнено» (число меняется с переходом).
import { h } from 'preact';
import { cx, Avatar, Icon, MessageStatus, ReplyQuote } from './kit.js';

/**
 * props: todo, from ('in'|'out'), groupStart, tail, appear, time, status, edited, forwarded, authorName,
 *        canToggle, onToggle(itemId, done), onReadOnly(), person(userId) → { name, tone?, avatar? (свойства Avatar) }.
 */
export function TodoBubble(props) {
  var t = props.todo, out = props.from === 'out';
  var done = {};
  t.completions.forEach(function (c) { done[c.id] = c; });
  var count = t.items.filter(function (it) { return done[it.id]; }).length;
  var group = t.othersCanComplete && !props.forwarded;
  var subtitle = props.forwarded ? 'Чек-лист' : t.othersCanComplete ? 'Общий чек-лист' : out ? 'Ваш чек-лист' : 'Чек-лист' + (props.authorName ? ' · ' + props.authorName : '');
  var interactive = !!props.canToggle;
  return h('div', { class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-bubble rl-todo', out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && 'rl-bubble-tail', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in')) },
      props.reply ? h(ReplyQuote, Object.assign({ inBubble: true }, props.reply)) : null,
      h('div', { class: 'rl-todo-head' }, h('b', { class: 'rl-todo-name' }, t.title), h('span', { class: 'rl-todo-sub' }, subtitle)),
      h('div', { class: 'rl-todo-items', role: 'group', 'aria-label': t.title },
        t.items.map(function (it) {
          var c = done[it.id], who = c && group && props.person ? props.person(c.by) : null;
          return h('div', {
            key: it.id, class: cx('rl-todo-item', c && 'rl-todo-done', !interactive && 'rl-todo-ro'),
            role: 'checkbox', 'aria-checked': String(!!c), tabIndex: 0, 'data-todo-item': it.id,
            onClick: function (e) { e.stopPropagation(); if (interactive) props.onToggle(it.id, !c); else if (props.onReadOnly) props.onReadOnly(); },
            onKeyDown: function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.currentTarget.click(); } },
          },
            h('span', { class: 'rl-todo-mark' },
              interactive
                ? h('span', { class: 'rl-todo-box', 'aria-hidden': 'true' }, h(Icon, { name: 'check', size: 14, strokeWidth: 3 }))
                : h('span', { class: 'rl-todo-ro-mark', 'aria-hidden': 'true' }, c ? h(Icon, { name: 'check', size: 16, strokeWidth: 2.6 }) : h('i', null)),
              who ? h('span', { class: 'rl-todo-who' }, h(Avatar, Object.assign({ name: who.fullName || who.name, tone: who.tone, size: 22 }, who.avatar))) : null),
            h('span', { class: 'rl-todo-text' },
              h('span', { class: 'rl-todo-title' }, it.title),
              who ? h('small', { class: 'rl-todo-by' }, who.name) : null));
        })),
      h('div', { class: 'rl-todo-foot' },
        h('span', { key: count, class: 'rl-todo-count' }, count), ' из ' + t.items.length + ' выполнено'),
      h('span', { class: 'rl-bubble-meta' }, props.edited ? h('span', { class: 'rl-bubble-edited' }, 'изм.') : null, props.time, out ? h(MessageStatus, { status: props.status || 'sent' }) : null)));
}
