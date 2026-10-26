// Календарь «Перейти к дате» — как в Telegram: месяц с листанием, неделя с понедельника, дни других месяцев
// и будущие — серые и неактивные, выбранный день — в круге, внизу кнопка действия. Окно — общий слой модалок.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
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

/* Превью медиа дня (как в Telegram): размытая миниатюра сразу, картинка проявляется поверх, когда разжата.
   in — день узнал о медиа уже на экране: превью проявляется целиком (иначе — сразу, без анимации). */
function DayMedia(props) {
  var loaded = useState(false), alive = useRef(true);
  useEffect(function () { alive.current = true; return function () { alive.current = false; }; }, []);
  useEffect(function () { loaded[1](false); }, [props.src]);
  function onLoad(e) {
    var img = e.currentTarget;
    function done() { if (alive.current) loaded[1](true); }
    if (!img.decode || document.hidden) return done();
    img.decode().then(done, done);
  }
  return h('span', { class: cx('rl-cal-media', props.in && 'rl-cal-media-in', loaded[0] && 'rl-cal-media-loaded'), 'aria-hidden': 'true' },
    props.thumb ? h('img', { class: 'rl-cal-media-thumb', src: props.thumb, alt: '' }) : null,
    props.src ? h('img', { class: 'rl-cal-media-full', src: props.src, alt: '', decoding: 'async', draggable: false, onLoad: onLoad }) : null);
}

/**
 * props: open, value (Date — выбран сразу), max (Date — позже нельзя, по умолчанию сегодня), min (Date),
 * title (кнопка, «Перейти к дате»), onPick(date: Date — полночь выбранного дня), onClose.
 * media(year, month) — Promise<{ [день]: { src?, thumb? } }>: превью медиа в днях месяца (как в Telegram), необязательно;
 * mediaCached(year, month) — то же, уже известное (или null): месяц из кэша рисуется сразу, без проявления.
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
  var mkey = y + ':' + m;
  var got = useState({});
  var cur = got[0][mkey] || (props.mediaCached && props.mediaCached(y, m)) || null;
  // дни с медиа, известные при первом показе месяца: им — без проявления; узнанные позже проявляются
  var visit = useRef({ key: '', had: null });
  if (!props.open) visit.current.key = '';   // открыли снова — что уже в кэше, без проявления
  if (visit.current.key !== mkey) visit.current = { key: mkey, had: cur || {} };
  useEffect(function () {
    if (!props.open || !props.media) return undefined;
    var live = true;
    props.media(y, m).then(function (days) { if (live) got[1](function (g) { var n = Object.assign({}, g); n[mkey] = days; return n; }); }, function () {});
    return function () { live = false; };
  }, [props.open, mkey]);
  var today = startOfDay(new Date());
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
        var pic = !off && cur ? cur[d.getDate()] : null;
        return h('button', { key: d.getTime(), type: 'button', role: 'gridcell',
          class: cx('rl-cal-day', off && 'rl-cal-off', on && 'rl-cal-on', sameDay(d, today) && 'rl-cal-today', pic && 'rl-cal-pic'),
          disabled: off, 'aria-selected': on ? 'true' : undefined, 'aria-label': d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }),
          onClick: function () { sel[1](d); }, onDblClick: function () { if (props.onPick) props.onPick(d); } },
          pic ? h(DayMedia, { src: pic.src, thumb: pic.thumb, in: !visit.current.had[d.getDate()] }) : null,
          h('span', { class: 'rl-cal-num' }, d.getDate()));
      })),
    h('button', { type: 'button', class: 'rl-btn rl-btn-primary rl-btn-lg rl-cal-go', onClick: function () { if (props.onPick) props.onPick(sel[0]); } }, props.title || 'Перейти к дате'));
}
