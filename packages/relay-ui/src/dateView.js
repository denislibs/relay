// Дата в пузыре — как в Telegram Web A: цвет ссылки, подсказка с полной датой; текст по формату сущности
// (относительная перерисовывается сама: внутри минуты — каждую секунду, часа — каждую минуту, суток — каждый час);
// без формата — текст сообщения. Нажатие — меню «Копировать дату».
import { h } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { Icon } from './kit.js';
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
    var t = setTimeout(function () { document.addEventListener('pointerdown', close, { once: true }); }, 0);
    return function () { clearTimeout(t); document.removeEventListener('pointerdown', close); if (openMenu === close) openMenu = null; };
  }, [menu[0]]);
  var text = format ? formatDateEntity(date, format) : null;
  var full = fullDate(date);
  return h('span', {
    class: 'rl-fdate', title: full, role: 'button', tabIndex: 0, 'data-unix': date,
    onClick: function (e) {
      e.preventDefault(); e.stopPropagation();
      if (openMenu) openMenu();
      // у нижнего края (над полем ввода) — меню над датой, иначе под ней
      var r = e.currentTarget.getBoundingClientRect(), below = r.bottom + 120 < innerHeight;
      menu[1](below ? { x: r.left, top: r.bottom + 4 } : { x: r.left, bottom: innerHeight - r.top + 4 });
    },
  }, text != null ? text : props.children,
    // меню — порталом в body: поверх ленты и поля ввода, а не внутри слоя ленты
    menu[0] ? createPortal(h('span', { class: 'rl-fdate-menu', style: { left: Math.min(menu[0].x, innerWidth - 240) + 'px', top: menu[0].top != null ? menu[0].top + 'px' : undefined, bottom: menu[0].bottom != null ? menu[0].bottom + 'px' : undefined }, onPointerDown: function (e) { e.stopPropagation(); } },
      h('span', { class: 'rl-fdate-menu-head' }, full),
      h('button', { type: 'button', class: 'rl-fdate-menu-item', onClick: function (e) {
        e.stopPropagation(); menu[1](null);
        copyRich(full).then(function () { if (props.onCopied) props.onCopied(); });
      } }, h(Icon, { name: 'copy', size: 18 }), 'Копировать дату')), document.body) : null);
}
