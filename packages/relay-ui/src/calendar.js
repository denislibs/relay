// Календарь «Перейти к дате» — как в Telegram: месяц с листанием, неделя с понедельника, дни других месяцев
// и будущие — серые и неактивные, выбранный день — в круге, внизу кнопка действия. Окно — общий слой модалок.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { cx, IconButton } from './kit.js';
import { Modal } from './modal.js';

var WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
var monthName = new Intl.DateTimeFormat('ru-RU', { month: 'long' });

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

/** Дни для сетки месяца: с понедельника недели, где 1-е число, до воскресенья недели, где последнее. */
export function monthGrid(year, month) {
  var first = new Date(year, month, 1);
  var shift = (first.getDay() + 6) % 7;   // понедельник — 0
  var days = new Date(year, month + 1, 0).getDate();
  var cells = Math.ceil((shift + days) / 7) * 7;
  var out = [];
  for (var i = 0; i < cells; i++) out.push(new Date(year, month, 1 - shift + i));
  return out;
}

/**
 * props: open, value (Date — выбран сразу), max (Date — позже нельзя, по умолчанию сегодня), min (Date),
 * title (кнопка, «Перейти к дате»), onPick(date: Date — полночь выбранного дня), onClose.
 */
export function DatePicker(props) {
  var max = startOfDay(props.max || new Date());
  var min = props.min ? startOfDay(props.min) : null;
  var init = startOfDay(props.value && props.value <= max ? props.value : max);
  var sel = useState(init), view = useState({ y: init.getFullYear(), m: init.getMonth() });
  // открыли снова (другая дата) — встаём на неё
  useEffect(function () { if (props.open) { sel[1](init); view[1]({ y: init.getFullYear(), m: init.getMonth() }); } }, [props.open, init.getTime()]);
  var y = view[0].y, m = view[0].m;
  var atMax = y > max.getFullYear() || (y === max.getFullYear() && m >= max.getMonth());
  var atMin = min && (y < min.getFullYear() || (y === min.getFullYear() && m <= min.getMonth()));
  function shift(d) { var t = new Date(y, m + d, 1); view[1]({ y: t.getFullYear(), m: t.getMonth() }); }
  var title = monthName.format(new Date(y, m, 1));
  title = title.charAt(0).toUpperCase() + title.slice(1) + ' ' + y;

  var header = h('div', { class: 'rl-mdl-head rl-cal-head' },
    h(IconButton, { icon: 'close', label: 'Закрыть', onClick: props.onClose }),
    h('h2', { class: 'rl-mdl-title', 'aria-live': 'polite' }, title),
    h(IconButton, { icon: 'chevronLeft', label: 'Предыдущий месяц', disabled: !!atMin, onClick: function () { shift(-1); } }),
    h(IconButton, { icon: 'chevronRight', label: 'Следующий месяц', disabled: atMax, onClick: function () { shift(1); } }));

  return h(Modal, { open: props.open, onClose: props.onClose, header: header, size: 'confirm', label: props.label || 'Перейти к дате', class: 'rl-cal' },
    h('div', { class: 'rl-cal-grid', role: 'grid', 'aria-label': title },
      WEEK.map(function (w) { return h('span', { key: w, class: 'rl-cal-wd', role: 'columnheader' }, w); }),
      monthGrid(y, m).map(function (d) {
        var other = d.getMonth() !== m, off = other || d > max || (min && d < min), on = sameDay(d, sel[0]);
        return h('button', { key: d.getTime(), type: 'button', role: 'gridcell', class: cx('rl-cal-day', off && 'rl-cal-off', on && 'rl-cal-on'),
          disabled: off, 'aria-selected': on ? 'true' : undefined, 'aria-label': d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }),
          onClick: function () { sel[1](d); }, onDblClick: function () { if (props.onPick) props.onPick(d); } }, d.getDate());
      })),
    h('button', { type: 'button', class: 'rl-btn rl-btn-primary rl-btn-lg rl-cal-go', onClick: function () { if (props.onPick) props.onPick(sel[0]); } }, props.title || 'Перейти к дате'));
}
