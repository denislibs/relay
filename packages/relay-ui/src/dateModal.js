// Окно «Формат даты» — как в Telegram Web A (пункт «Дата» в меню вложений):
//  превью (нажатие — календарь и время), вкладки «Относительно» / «Точно», дата «Нет / Кратко / Полностью»
//  (по умолчанию полностью), время «Нет / Кратко / Полностью» (по умолчанию кратко), флажок «День недели».
//  Относительно — остальные настройки гаснут. «Сохранить» / Enter — вставить дату в поле ввода.
// mode 'mark' (⌘D на выделении) — только выбор даты и времени: дата привязывается к выделенному тексту без формата.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { cx, Checkbox } from './kit.js';
import { Modal } from './modal.js';
import { DatePicker } from './calendar.js';
import { buildDateFormat, defaultDateLabel, formatDateEntity, fullDate, parseDateFormat } from './formattedDate.js';

function Tabs(props) {
  return h('div', { class: cx('rl-dm-tabs', props.disabled && 'rl-dm-off'), role: 'radiogroup', 'aria-label': props.label },
    props.items.map(function (it) {
      return h('button', { key: it[0], type: 'button', role: 'radio', 'aria-checked': String(props.value === it[0]), disabled: props.disabled,
        class: cx('rl-dm-tab', props.value === it[0] && 'rl-dm-tab-on'), onClick: function () { props.onChange(it[0]); } }, it[1]);
    }));
}

function two(n) { return (n < 10 ? '0' : '') + n; }

/** props: open, mode ('format' | 'mark'), initial { date, format }, onSubmit({ date, format, label }), onClose. */
export function DateModal(props) {
  var init = props.initial;
  var start = useState(function () { var d = init ? new Date(init.date * 1000) : new Date(); d.setSeconds(0, 0); return d; });
  var opts = useState(function () { return init && init.format != null ? parseDateFormat(init.format) : { relative: false, date: 'long', time: 'short', weekday: false }; });
  var pick = useState(false);
  var when = start[0], o = opts[0];
  var unix = Math.floor(when.getTime() / 1000);
  var format = buildDateFormat(o);
  var mark = props.mode === 'mark';
  var preview = mark ? fullDate(unix) : (formatDateEntity(unix, format) || defaultDateLabel(unix));
  function set(p) { opts[1](Object.assign({}, o, p)); }
  function setTime(h0, m0) { var d = new Date(when); d.setHours(h0, m0, 0, 0); start[1](d); }
  function submit() { props.onSubmit({ date: unix, format: mark ? '' : format, label: defaultDateLabel(unix) }); }
  return h(Modal, {
    open: props.open !== false, onClose: props.onClose, title: mark ? 'Дата' : 'Формат даты', size: 'slim', class: 'rl-dm',
    actions: [h('button', { key: 's', type: 'button', class: 'rl-todo-submit', onClick: submit }, 'Сохранить')],
  },
    h('div', { onKeyDown: function (e) { if (e.key === 'Enter' && e.target.nodeName !== 'BUTTON') { e.preventDefault(); submit(); } } },
      h('div', { class: 'rl-todo-sec' }, 'Предпросмотр'),
      h('button', { type: 'button', class: 'rl-dm-preview', title: fullDate(unix), onClick: function () { pick[1](true); } }, preview),
      h('div', { class: 'rl-dm-time' },
        h('span', null, 'Время'),
        h('input', { type: 'time', class: 'rl-dm-timein', value: two(when.getHours()) + ':' + two(when.getMinutes()), 'aria-label': 'Время',
          onInput: function (e) { var p = e.currentTarget.value.split(':'); if (p.length === 2) setTime(+p[0], +p[1]); } })),
      mark ? null : [
        h('div', { key: 'm', class: 'rl-todo-sec' }, 'Вид'),
        h(Tabs, { key: 'mt', label: 'Вид', value: o.relative ? 'rel' : 'abs', items: [['rel', 'Относительно'], ['abs', 'Точно']], onChange: function (v) { set({ relative: v === 'rel' }); } }),
        h('div', { key: 'd', class: 'rl-todo-sec' }, 'Дата'),
        h(Tabs, { key: 'dt', label: 'Дата', disabled: o.relative, value: o.date, items: [['none', 'Нет'], ['short', 'Кратко'], ['long', 'Полностью']], onChange: function (v) { set({ date: v }); } }),
        h('div', { key: 't', class: 'rl-todo-sec' }, 'Время'),
        h(Tabs, { key: 'tt', label: 'Время', disabled: o.relative, value: o.time, items: [['none', 'Нет'], ['short', 'Кратко'], ['long', 'Полностью']], onChange: function (v) { set({ time: v }); } }),
        h('div', { key: 'w', class: cx('rl-dm-week', o.relative && 'rl-dm-off') },
          h(Checkbox, { id: 'dm-week', checked: o.weekday, disabled: o.relative, onChange: function () { set({ weekday: !o.weekday }); } }, 'День недели')),
      ]),
    pick[0] ? h(DatePicker, {
      open: true, value: when, max: new Date(2099, 11, 31), min: new Date(1971, 0, 1), title: 'Выбрать',
      onPick: function (day) { var d = new Date(day); d.setHours(when.getHours(), when.getMinutes(), 0, 0); start[1](d); pick[1](false); },
      onClose: function () { pick[1](false); },
    }) : null);
}
