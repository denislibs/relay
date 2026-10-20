// Стикеры-герои страниц настроек (торт, папка, ключ…): собираются в .tgs при сборке (stickers/build.ts).
// Рисует общий плеер (StickerView, tlottie в воркерах): проигрываются один раз при показе, повтор — по клику
// или наведению. При уменьшении движения — первый кадр.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { StickerView } from './StickerView.js';

var base = '/stickers/';

/** Где лежат .tgs героев. */
export function configureStickers(opts) {
  if (opts && opts.base) base = opts.base;
}

/**
 * props: name (файл без .tgs), size (px, по умолчанию 120), replay ('hover' | 'click' | 'both' | null),
 * label (для скринридера; без него — декор), class.
 */
export function Sticker(props) {
  var size = props.size || 120;
  var replay = props.replay === undefined ? 'both' : props.replay;
  var st = useState(0), again = function () { st[1](function (n) { return n + 1; }); };
  return h('div', {
    class: props.class, style: { display: 'inline-block', width: size + 'px', height: size + 'px' },
    role: props.label ? 'img' : undefined, 'aria-label': props.label, 'aria-hidden': props.label ? undefined : 'true',
    onPointerEnter: replay === 'hover' || replay === 'both' ? again : undefined,
    onClick: replay === 'click' || replay === 'both' ? again : undefined,
  }, h(StickerView, { src: base + props.name + '.tgs', size: size, w: 512, h: 512, loop: false, group: 'hero', replay: st[0], title: props.label }));
}
