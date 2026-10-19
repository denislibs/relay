// Дата в пузыре — как в Telegram Web A: цвет ссылки, подсказка с полной датой; текст по формату сущности
// (относительная перерисовывается сама: внутри минуты — каждую секунду, часа — каждую минуту, суток — каждый час);
// без формата — текст сообщения. Нажатие — меню «Копировать дату».
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { MenuPopover } from './popover.js';
import { formatDateEntity, fullDate, relativeRefreshMs } from './formattedDate.js';
import { copyRich } from './messageCopy.js';

var openMenu = null;   // одно открытое меню даты на всё приложение

export function FormattedDate(props) {
  var p = String(props.value).split('|'), date = +p[0], format = p[1] || '';
  var tick = useState(0), menu = useState(null);
  useEffect(function () {
    if (format !== 'r') return;
    var t, live = true;
    (function plan() {
      var ms = relativeRefreshMs(date);
      if (!ms) return;
      t = setTimeout(function () { if (!live) return; tick[1](function (n) { return n + 1; }); plan(); }, ms);
    })();
    return function () { live = false; clearTimeout(t); };
  }, [date, format]);
  useEffect(function () {
    if (!menu[0]) return;
    function close() { menu[1](null); }
    openMenu = close;
    return function () { if (openMenu === close) openMenu = null; };
  }, [menu[0]]);
  var text = format ? formatDateEntity(date, format) : null;
  var full = fullDate(date);
  return h('span', {
    class: 'rl-fdate', title: full, role: 'button', tabIndex: 0, 'data-unix': date,
    onClick: function (e) {
      e.preventDefault(); e.stopPropagation();
      if (openMenu) openMenu();
      menu[1](e.currentTarget);   // меню — у даты (у нижнего края окна — над ней)
    },
  }, text != null ? text : props.children,
    h(MenuPopover, { open: !!menu[0], anchor: menu[0], placement: 'bottom-start', label: 'Дата', onClose: function () { menu[1](null); },
      menuHeader: h('span', { class: 'rl-fdate-menu-head' }, full),
      items: [{ icon: 'copy', label: 'Копировать дату', onClick: function () { copyRich(full).then(function () { if (props.onCopied) props.onCopied(); }); } }] }));
}
