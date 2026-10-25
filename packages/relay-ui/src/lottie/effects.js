// Эффект реакции — как в Telegram Web K: поверх иконки плашки анимация center (40 px), вокруг неё around (80 px);
// оба плеера ждут первый кадр и стартуют синхронно, иконка на это время прячется. Рисуется в фиксированном
// слое поверх ленты (не в её раскладке): позиция пересчитывается на прокрутку, за экраном эффект снимается.
// Один эффект на плашку, не больше FX_MAX одновременно, страховочный таймер — если плеер не доиграл.
import { attachSticker } from './player.js';
import { requestMeasure, requestMutation } from '../schedule.js';

export const FX_MAX = 4;
export const FX_TIMEOUT_MS = 3000;
export const CENTER_PX = 40;
export const AROUND_PX = 80;
export const EMOJI_FX_PX = 360;
export const EMOJI_FX_MAX = 3;

/** DOM-часть отдельно: тесты подменяют её (bun без DOM). */
function browserDom() {
  let layer = null;
  const ensure = () => {
    if (!layer || !layer.isConnected) { layer = document.createElement('div'); layer.className = 'rl rl-fx-layer'; document.body.appendChild(layer); }
    return layer;
  };
  return {
    make() {
      const node = document.createElement('div'); node.className = 'rl-fx-item';
      const around = document.createElement('canvas'); around.className = 'rl-fx-around';
      const center = document.createElement('canvas'); center.className = 'rl-fx-center';
      node.append(around, center);
      ensure().appendChild(node);
      return {
        center, around,
        place(x, y) { node.style.transform = `translate(${x}px, ${y}px)`; },
        dropCenter() { center.remove(); },
        remove() { node.remove(); },
      };
    },
    makeBig() {
      const node = document.createElement('div'); node.className = 'rl-fx-item rl-fx-item-big';
      const canvas = document.createElement('canvas'); canvas.className = 'rl-fx-big';
      node.appendChild(canvas);
      ensure().appendChild(node);
      return {
        canvas,
        place(x, y, mirror) { node.style.transform = `translate(${x}px, ${y}px)` + (mirror ? ' scaleX(-1)' : ''); },
        remove() { node.remove(); },
      };
    },
    rect(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, width: r.width, height: r.height, top: r.top, bottom: r.bottom, gone: !el.isConnected }; },
    hide(el, on) { el.classList.toggle('rl-react-icon-hidden', on); },
    onScroll(fn) { document.addEventListener('scroll', fn, true); return () => document.removeEventListener('scroll', fn, true); },
    viewHeight: () => window.innerHeight,
    dpr: () => Math.min(2, Math.max(1, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1)),
    vibrate(ms) { try { navigator.vibrate?.(ms); } catch { /* нет вибрации */ } },
  };
}

/**
 * deps: attach (attachSticker), dom (см. browserDom), measure/mutate (фазы кадра), setTimeout/clearTimeout, raf.
 */
export function createEffects(deps = {}) {
  const attach = deps.attach || attachSticker;
  const dom = deps.dom || browserDom();
  const measure = deps.measure || requestMeasure, mutate = deps.mutate || requestMutation;
  const later = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms)), cancel = deps.clearTimeout || ((t) => clearTimeout(t));
  const raf = deps.raf || ((fn) => requestAnimationFrame(fn));
  const live = new Map();   // иконка плашки → эффект

  /** Запустить эффект над иконкой плашки; false — уже идёт, лимит или нет ассетов. */
  function play(iconEl, assets) {
    if (!iconEl || !assets || !assets.center || !assets.around) return false;
    if (live.has(iconEl) || live.size >= FX_MAX) return false;
    const box = dom.make();
    const item = { ready: 0, started: false, done: 0, timer: 0, views: [], off: null, raf: 0 };
    live.set(iconEl, item);

    const finish = () => {
      if (live.get(iconEl) !== item) return;
      live.delete(iconEl);
      cancel(item.timer);
      if (item.off) item.off();
      for (const v of item.views) v.destroy();
      dom.hide(iconEl, false);
      box.remove();
    };
    const place = () => {
      const r = dom.rect(iconEl);
      if (r.gone || r.bottom < 0 || r.top > dom.viewHeight()) { finish(); return; }
      box.place(r.x, r.y);
    };
    // оба первых кадра на месте — старт в одной мутации: иконка прячется, плееры идут, вибрация
    const onFirst = () => {
      if (++item.ready < 2 || item.started) return;
      item.started = true;
      mutate(() => {
        if (live.get(iconEl) !== item) return;
        dom.hide(iconEl, true);
        for (const v of item.views) v.setPlay(true);
        dom.vibrate(100);
      });
    };
    const part = () => { if (++item.done >= 2) finish(); };
    const d = dom.dpr();
    item.views = [
      attach({ url: assets.center, px: Math.round(CENTER_PX * d), canvas: box.center, group: 'fx', play: false, loop: false, force: true, shared: false,
        onFirstFrame: onFirst, onError: finish,
        // центр доиграл — иконка возвращается в следующем кадре, вокруг ещё летит
        onEnded: () => { mutate(() => { if (live.get(iconEl) !== item) return; dom.hide(iconEl, false); box.dropCenter(); }); part(); } }),
      attach({ url: assets.around, px: Math.round(AROUND_PX * d), canvas: box.around, group: 'fx', play: false, loop: false, force: true, shared: false,
        onFirstFrame: onFirst, onError: finish, onEnded: part }),
    ];
    for (const v of item.views) v.setVisible(true);
    item.timer = later(finish, FX_TIMEOUT_MS);
    item.off = dom.onScroll(() => { if (!item.raf) item.raf = raf(() => { item.raf = 0; measure(place); }); });
    measure(place);
    return true;
  }

  const big = new Set();   // идущие эффекты у больших эмодзи

  /**
   * Эффект у большого эмодзи (как в tweb): 360 px, якорь — рамка стикера; side right — у исходящих (x = right − 360),
   * left — у входящих (x = left); сдвиг наружу 16 px и случайный ±16/±4; по вертикали центр по стикеру; mirror —
   * отражение. Не больше EMOJI_FX_MAX одновременно; снимается на последнем кадре, за экраном или по таймеру.
   */
  function playBig(el, opts) {
    if (!el || !opts || !opts.url || big.size >= EMOJI_FX_MAX) return false;
    const box = dom.makeBig();
    const item = { timer: 0, off: null, raf: 0, view: null };
    big.add(item);
    const right = opts.side === 'right';
    const dx = (right ? 16 : -16) + (Math.random() * 32 - 16), dy = Math.random() * 8 - 4;
    const finish = () => {
      if (!big.has(item)) return;
      big.delete(item);
      cancel(item.timer);
      if (item.off) item.off();
      if (item.view) item.view.destroy();
      box.remove();
    };
    const place = () => {
      const r = dom.rect(el);
      if (r.gone || r.bottom < 0 || r.top > dom.viewHeight()) { finish(); return; }
      const x = (right ? r.right - EMOJI_FX_PX : r.left) + dx * (r.width / 200);
      const y = r.top + (r.height - EMOJI_FX_PX) / 2 + dy;
      box.place(x, y, !!opts.mirror);
    };
    item.view = attach({ url: opts.url, px: Math.round(EMOJI_FX_PX * dom.dpr()), canvas: box.canvas, group: 'fx', play: true, loop: false, force: true, shared: false,
      onFirstFrame: () => dom.vibrate(100), onEnded: finish, onError: finish });
    item.view.setVisible(true);
    item.timer = later(finish, FX_TIMEOUT_MS * 2);
    item.off = dom.onScroll(() => { if (!item.raf) item.raf = raf(() => { item.raf = 0; measure(place); }); });
    measure(place);
    return true;
  }

  return { play, playBig, active: () => live.size, activeBig: () => big.size };
}

const shared = createEffects();
/** Эффект реакции над иконкой плашки: assets — { center, around } (адреса .tgs из каталога). */
export const playReactionEffect = (iconEl, assets) => shared.play(iconEl, assets);
export const activeEffects = () => shared.active();
/** Эффект у большого эмодзи: opts — { url, side: 'left'|'right', mirror }. */
export const playEmojiInteraction = (el, opts) => shared.playBig(el, opts);
