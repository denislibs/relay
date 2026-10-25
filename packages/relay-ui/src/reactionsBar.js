// Панель быстрых реакций над контекстным меню — как в Telegram Web K: семь реакций, у каждой «появление»
// (appear) один раз, затем «выбор» (select) на нулевом кадре, при наведении — select с начала; шеврон «ещё».
// Панель невидима, пока у всех ячеек не отрисован первый кадр (или не прошло BAR_READY_MS) — иначе иконки
// подъезжали бы по одной.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon } from './kit.js';
import { StickerView } from './StickerView.js';

export const BAR_READY_MS = 150;

/** Переходы ячейки: appear → (кадр кончился) → select; наведение играет select, только когда он стоит. */
export function cellNext(stage, event) {
  if (event === 'appearEnded') return stage === 'appear' ? 'select' : stage;
  if (event === 'hover') return stage === 'select' ? 'playing' : stage;
  if (event === 'selectEnded') return stage === 'playing' ? 'select' : stage;
  return stage;
}

/** Готовность панели: все ячейки отрисовали первый кадр либо вышло время ожидания. */
export function barReady(got, total, waitedMs) {
  return got >= total || waitedMs >= BAR_READY_MS;
}

function Cell(props) {
  var a = props.asset;
  var animated = props.animated && a.appear && a.select;
  var st = useState(animated ? 'appear' : 'static'), stage = st[0], setStage = st[1];
  var first = useRef(false);
  var onFirst = function () { if (!first.current) { first.current = true; props.onFirstFrame(); } };
  // глиф без картинки — готов сразу
  useEffect(function () { if (!a.static && !animated) onFirst(); }, []);
  var dispatch = function (ev) { setStage(function (s) { return cellNext(s, ev); }); };
  return h('button', {
    type: 'button', class: cx('rl-rpick-btn', props.selected && 'rl-rpick-on'), style: { '--i': props.index },
    'aria-label': 'Реакция ' + (a.title || a.key), 'aria-pressed': String(!!props.selected),
    onClick: function () { props.onPick(a.key); },
    onMouseEnter: function () { dispatch('hover'); },
  },
    stage === 'static'
      ? (a.static
        ? h('img', { class: 'rl-rpick-img', src: a.static, alt: '', draggable: false, decoding: 'async', onLoad: onFirst, onError: onFirst })
        : h('span', { class: 'rl-rpick-glyph' }, a.key))
      : [
        // select лежит под appear с нулевого кадра: подмена без мигания; играет только по наведению
        h(StickerView, { key: 's', class: 'rl-rpick-anim', src: a.select, w: 512, h: 512, size: 28, group: 'menu', force: true, loop: false,
          play: stage === 'playing', onEnded: function () { dispatch('selectEnded'); } }),
        stage === 'appear' ? h(StickerView, { key: 'a', class: 'rl-rpick-anim', src: a.appear, w: 512, h: 512, size: 28, group: 'menu', force: true, loop: false, play: true,
          onFirstFrame: onFirst, onEnded: function () { requestAnimationFrame(function () { dispatch('appearEnded'); }); } }) : null,
      ]);
}

/**
 * props: items — [{ key, title?, static?, appear?, select? }] (из каталога реакций; без адресов — глифы),
 * selected — моя реакция (ключ), animated — играть lottie (иначе static), more — показывать шеврон «ещё»,
 * onPick(key), onMore(event).
 */
export function ReactionsBar(props) {
  var items = props.items || [];
  var ready = useState(false), got = useRef(0);
  useEffect(function () {
    var t = setTimeout(function () { ready[1](true); }, BAR_READY_MS);
    return function () { clearTimeout(t); };
  }, []);
  var onFirst = function () { if (++got.current >= items.length) ready[1](true); };
  return h('div', { class: cx('rl-rpick', ready[0] && 'is-ready'), role: 'toolbar', 'aria-label': 'Реакции' },
    items.map(function (a, i) {
      return h(Cell, { key: a.key, asset: a, index: i, selected: props.selected === a.key, animated: !!props.animated, onFirstFrame: onFirst, onPick: props.onPick });
    }),
    // шеврон «ещё» — только когда доступных реакций больше, чем в панели (как в Telegram)
    props.more ? h('button', { type: 'button', class: 'rl-rpick-btn rl-rpick-more', style: { '--i': items.length }, 'aria-label': 'Другие реакции', onClick: props.onMore }, h(Icon, { name: 'chevronDown', size: 22 })) : null,
    h('i', { class: 'rl-rpick-tail', 'aria-hidden': 'true' }));
}
