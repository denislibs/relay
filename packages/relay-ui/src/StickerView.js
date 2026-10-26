// Стикер: силуэт → сохранённый первый кадр → анимация. Слои лежат друг на друге; нижние убираются,
// только когда кадр анимации уже нарисован и прошло два кадра браузера — без мигания. Фейд — лишь если
// под анимацией был один силуэт (с превью кадры совпадают, менять нечего).
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, lazyObserve, reducedMotion, MsgLine, ForwardTitle, ReplyQuote, ReactionChips, MessageStatus } from './kit.js';
import { attachSticker } from './lottie/player.js';
import { lottieAvailable } from './lottie/pool.js';
import { decodeOutline } from './lottie/outline.js';
import { getPreview } from './lottie/previews.js';
import { requestMutation } from './schedule.js';

// одно наблюдение «на экране ли» на все стикеры
const seen = new Map();
let io = null;
function watchVisible(el, cb) {
  if (typeof IntersectionObserver === 'undefined') { cb(true); return () => {}; }
  io ??= new IntersectionObserver((entries) => { for (const e of entries) seen.get(e.target)?.(e.isIntersecting); });
  seen.set(el, cb);
  io.observe(el);
  return () => { seen.delete(el); io.unobserve(el); };
}

// плееры подключаются по очереди, не больше двух за кадр (как очередь загрузки в Telegram Web K): быстрая
// прокрутка панели стикеров иначе создавала десятки плееров и холстов в одном кадре
const ATTACH_PER_FRAME = 2;
const attachQueue = [];
let attachRaf = 0;
function queueAttach(fn) {
  const job = { fn, live: true };
  attachQueue.push(job);
  if (!attachRaf) attachRaf = requestAnimationFrame(runAttach);
  return () => { job.live = false; };
}
function runAttach() {
  attachRaf = 0;
  let n = 0;
  while (attachQueue.length && n < ATTACH_PER_FRAME) { const j = attachQueue.shift(); if (j.live) { j.fn(); n++; } }
  if (attachQueue.length) attachRaf = requestAnimationFrame(runAttach);
}

/** Вписать w×h в квадрат size (CSS px). */
export function stickerBox(w, h, size) {
  const k = size / Math.max(w || 512, h || 512);
  return { width: Math.round((w || 512) * k), height: Math.round((h || 512) * k) };
}

const outlines = new Map();
function outlinePath(b64) {
  if (!b64) return '';
  let p = outlines.get(b64);
  if (p === undefined) { p = decodeOutline(b64); if (outlines.size > 500) outlines.clear(); outlines.set(b64, p); }
  return p;
}

/**
 * props: src (адрес .tgs/.json/.webp), outline (base64 контур), w, h (размер документа, обычно 512),
 * size (сторона рамки, CSS px), play (по умолчанию да), loop (undefined — как в настройках), group, force (играть
 * вопреки тяжёлой анимации и автоплею), shared (false — свои часы), atEnd (сразу последний кадр: исход броска),
 * onFirstFrame, onEnded (последний кадр без цикла), class, onClick, title.
 */
export function StickerView(props) {
  const { src, outline, size, group = 'feed', play = true, loop, force, shared = true, atEnd = false } = props;
  const box = stickerBox(props.w, props.h, size);
  const isStatic = /\.webp$/.test(src || '');
  const px = Math.round(Math.max(box.width, box.height) * Math.min(2, Math.max(1, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1)));
  const key = src + '|' + px;
  const root = useRef(null), canvas = useRef(null), ctl = useRef(null);
  const [preview, setPreview] = useState(null);
  const [stage, setStage] = useState('outline');      // outline → ready (+ fade, если превью не было)
  const hadPreview = useRef(false);

  // превью с прошлого раза (для статичных стикеров сама картинка — превью)
  useEffect(() => {
    setStage('outline'); setPreview(null); hadPreview.current = false;
    if (isStatic || !src || atEnd) return;   // превью — первый кадр, а показать надо последний
    let live = true;
    getPreview(key).then((url) => {
      if (!live || !url) return;
      const img = new Image();
      img.src = url;
      img.decode().then(() => { if (live) { hadPreview.current = true; setPreview(url); } }, () => {});
    });
    return () => { live = false; };
  }, [key]);

  // анимация: подключаемся, когда стикер подъехал к экрану (500 px), играем — пока виден. force (бросок на глазах,
  // эффект) — сразу: ленивое наблюдение ждёт конца тяжёлой анимации (доезда ленты), а показать надо сейчас
  useEffect(() => {
    const el = root.current;
    if (!el || !src || isStatic || !lottieAvailable()) return;
    let offVisible = null, cancel = null;
    const attach = () => { cancel = queueAttach(() => {
      const c = attachSticker({
        url: src, px, canvas: canvas.current, group, play: play && !reducedMotion(), loop, force, shared, atEnd,
        onFirstFrame: () => { props.onFirstFrame?.(); requestAnimationFrame(() => requestAnimationFrame(() => requestMutation(() => setStage('ready')))); },
        onEnded: () => props.onEnded?.(),
        onError: () => props.onError?.(),
      });
      ctl.current = c;
      offVisible = watchVisible(el, (v) => c.setVisible(v));
    }); };
    const offLazy = force ? (attach(), null) : lazyObserve(el, attach);
    return () => { offLazy?.(); cancel?.(); offVisible?.(); ctl.current?.destroy(); ctl.current = null; };
  }, [key, group, force]);

  useEffect(() => { ctl.current?.setPlay(play && !reducedMotion()); }, [play]);
  useEffect(() => { ctl.current?.setLoop(loop); }, [loop]);
  // replay: новое значение — проиграть с начала
  useEffect(() => { if (props.replay) ctl.current?.restart(); }, [props.replay]);

  const path = outlinePath(outline);
  const ready = stage === 'ready';
  return h('div', {
    ref: root,
    class: cx('rl-sticker', ready && 'rl-sticker-ready', ready && !hadPreview.current && 'rl-sticker-fade', props.class),
    style: { width: box.width + 'px', height: box.height + 'px' },
    onClick: props.onClick,
    title: props.title,
    role: props.onClick ? 'button' : 'img',
    'aria-label': props.title || 'Стикер',
  },
    !ready && path ? h('svg', { class: 'rl-sticker-outline', viewBox: `0 0 ${props.w || 512} ${props.h || 512}`, 'aria-hidden': 'true' }, h('path', { d: path })) : null,
    isStatic
      ? h('img', { class: 'rl-sticker-static', src, alt: '', draggable: false, decoding: 'async', onLoad: () => setStage('ready') })
      : [
        !ready && preview ? h('img', { key: 'p', class: 'rl-sticker-preview', src: preview, alt: '', draggable: false }) : null,
        h('canvas', { key: 'c', ref: canvas, class: 'rl-sticker-canvas', 'aria-hidden': 'true' }),
      ]);
}

/** Сторона рамки стикера в ленте: 200 px, на узком экране 180 (как в Telegram Web). */
export const stickerMsgSize = () => (typeof innerWidth === 'number' && innerWidth < 600 ? 180 : 200);

/**
 * Сообщение-стикер: без пузыря и тени. Время и статус — плашкой в правом нижнем углу; пересылка, автор и ответ —
 * маленьким пузырём над стикером; реакции — под ним. Клик по стикеру — onOpen (модалка пака).
 */
export function StickerBubble(props) {
  const out = props.from === 'out';
  const s = props.sticker;
  const head = props.fwd || props.author || props.reply;
  return h(MsgLine, { aside: props.aside, class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-sticker-msg', out ? 'rl-sticker-msg-out' : 'rl-sticker-msg-in', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in')) },
      head ? h('div', { class: cx('rl-sticker-head', out && 'rl-sticker-head-out') },
        props.fwd ? h(ForwardTitle, { fwd: props.fwd }) : null,
        props.author && !props.fwd ? h('span', { class: 'rl-bubble-author', style: { color: 'var(--peer-' + (props.authorTone != null ? props.authorTone : 5) + ')' } }, props.author) : null,
        props.reply ? h(ReplyQuote, Object.assign({ inBubble: true }, props.reply)) : null) : null,
      h('div', { class: 'rl-sticker-box' },
        h(StickerView, { src: s.url, outline: s.outline, w: s.w, h: s.h, size: props.size || stickerMsgSize(), group: 'feed',
          title: s.emoji ? 'Стикер ' + s.emoji : 'Стикер', onClick: props.onOpen ? (e) => { e.stopPropagation(); props.onOpen(); } : undefined }),
        h('span', { class: 'rl-media-chip rl-sticker-meta' }, props.metaBefore ? props.metaBefore() : null, props.time, out || props.status ? h(MessageStatus, { status: props.status || 'read' }) : null)),
      // пост канала: кнопка комментариев плашкой под стикером (пузыря нет), шириной со стикер
      props.footer ? h('div', { class: 'rl-footer-plate' }, props.footer) : null,
      props.reactions && props.reactions.length ? h(ReactionChips, { items: props.reactions, out, float: true, onClick: props.onReact }) : null));
}

/** Миниатюра стикера для цитаты и поиска: у картинки — сам файл, у анимации — силуэт (SVG data:), без загрузок. */
export function stickerThumb(s) {
  if (!s) return null;
  if (s.format === 'webp') return s.url;
  const path = outlinePath(s.outline);
  if (!path) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s.w || 512} ${s.h || 512}"><path fill="#8a8f94" fill-opacity=".55" d="${path}"/></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
