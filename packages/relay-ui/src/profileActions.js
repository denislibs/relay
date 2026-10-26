// Ряд действий под именем в «Информации» — как в Telegram Web K: белые плитки равной ширины (иконка над подписью),
// не больше MAX вместе с «Ещё». Не влезли — первые MAX − 1 на виду, остальные и пункты только для меню — в «Ещё».
import { h } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { cx, ripple, Icon } from './kit.js';
import { MenuPopover } from './popover.js';

var MAX = 4;

/**
 * actions — плитки по приоритету: { key, icon, label, menuLabel?, danger?, onClick }.
 * menu — пункты только для «Ещё»: { icon, label, danger?, onClick }.
 */
function ProfileActions(props) {
  var tiles = props.actions || [], extra = props.menu || [];
  var fits = tiles.length + (extra.length ? 1 : 0) <= MAX;
  var shown = fits ? tiles : tiles.slice(0, MAX - 1);
  var rest = fits ? [] : tiles.slice(MAX - 1);
  var menuItems = rest.map(function (t) { return { icon: t.icon, label: t.menuLabel || t.label, danger: t.danger, onClick: t.onClick }; }).concat(extra);
  var open = useState(false), moreRef = useRef(null);
  if (!shown.length && !menuItems.length) return null;
  var tile = function (key, icon, label, onClick, danger, more) {
    return h('button', { key: key, type: 'button', ref: more ? moreRef : undefined, class: cx('rl-pact', danger && 'rl-pact-danger', more && open[0] && 'is-open'),
      onPointerDown: ripple, onClick: onClick, 'aria-haspopup': more ? 'menu' : undefined, 'aria-expanded': more ? String(open[0]) : undefined },
      h(Icon, { name: icon, size: 24 }), h('span', { class: 'rl-pact-label' }, label));
  };
  return h('div', { class: 'rl-pacts', role: 'group', 'aria-label': props.label || 'Действия' },
    shown.map(function (t) { return tile(t.key, t.icon, t.label, t.onClick, t.danger, false); }),
    menuItems.length ? tile('more', 'more', 'ещё', function () { open[1](!open[0]); }, false, true) : null,
    menuItems.length ? h(MenuPopover, { open: open[0], anchor: moreRef.current || undefined, placement: 'bottom-end', label: 'Ещё', items: menuItems, onClose: function () { open[1](false); } }) : null);
}

export { ProfileActions };
