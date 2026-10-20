// Проигрыватель стикеров: одни часы на анимацию (адрес + размер), сколько бы её копий ни было на экране.
// Кадры рисует воркер (pool.js), здесь — время, паузы и вывод в канвасы. Вывод — в фазе записи кадра
// (requestMutation), чтения раскладки здесь нет.
//
// Играет, только если: копия на экране, вкладка видна и окно в фокусе, нет тяжёлой анимации интерфейса,
// группа не перекрыта «эксклюзивной» (модалка стикерпака), автовоспроизведение разрешено.
import { openRenderer } from './pool.js';
import { savePreview } from './previews.js';
import { isHeavyAnimating, onHeavyAnimationEnd, requestMutation } from '../schedule.js';

const policy = { autoplay: true, loop: true };
let exclusive = null;
let focused = typeof document === 'undefined' ? true : !document.hidden && (document.hasFocus?.() ?? true);
const players = new Map();   // ключ → Player
const active = new Set();    // играющие (часы идут)
let ticking = false;

/** Настройки «Производительности»: автовоспроизведение и цикл. Применяются к живым стикерам сразу. */
export function setStickerPolicy(p) {
  Object.assign(policy, p);
  for (const pl of players.values()) pl.update();
}

/** «Играет только эта группа» (модалка стикерпака, просмотр); null — снять. */
export function setStickerGroupExclusive(group) {
  exclusive = group;
  for (const pl of players.values()) pl.update();
}

export const stickerPolicy = () => ({ ...policy });
export const stickerGroupExclusive = () => exclusive;

if (typeof window !== 'undefined') {
  const sync = () => {
    const next = !document.hidden && document.hasFocus();
    if (next === focused) return;
    focused = next;
    for (const pl of players.values()) pl.update();
  };
  addEventListener('blur', sync);
  addEventListener('focus', sync);
  document.addEventListener('visibilitychange', sync);
}

// тяжёлая анимация закончилась — все снова решают, играть ли (один ждущий на всех)
let heavyWait = false;
function wakeAfterHeavy() {
  if (heavyWait) return;
  heavyWait = true;
  onHeavyAnimationEnd(() => { heavyWait = false; for (const pl of players.values()) pl.update(); });
}

function tick() {
  ticking = false;
  if (!active.size) return;
  const now = performance.now();
  for (const pl of active) pl.advance(now);
  if (active.size) schedule();
}
function schedule() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => requestMutation(tick));
}

class Player {
  constructor(key, url, px) {
    this.key = key; this.url = url; this.px = px;
    this.views = new Set();
    this.renderer = null;
    this.index = 0;          // показанный кадр
    this.time = 0;           // мс проигранного времени (на паузе стоит)
    this.last = 0;           // performance.now() прошлого шага
    this.ended = false;
    this.wanted = -1;        // кадр, который ждём из воркера
    this.shownOnce = false;
    this.closed = false;
    const start = () => {
      if (this.closed) return;
      openRenderer({ url, px }).then((r) => {
        if (this.closed) { r.release(); return; }
        this.renderer = r;
        this.show(0);        // первый кадр сразу — даже если играть нельзя
        this.update();
      }, () => { for (const v of this.views) v.onError?.(); });
    };
    // во время тяжёлой анимации (открытие панели, модалки) даже не начинаем: WASM и сеть подождут
    if (isHeavyAnimating()) onHeavyAnimationEnd(start); else start();
  }

  playable() {
    if (!this.renderer || !focused || !policy.autoplay || isHeavyAnimating()) return false;
    for (const v of this.views) if (v.visible && v.play && (!exclusive || v.group === exclusive)) return true;
    return false;
  }

  loops() {
    for (const v of this.views) if (v.loop ?? policy.loop) return true;
    return false;
  }

  update() {
    const go = this.playable();
    if (go && !active.has(this)) {
      if (this.ended) { this.ended = false; this.time = 0; }   // снова на экране — проигрываем заново
      active.add(this);
      this.last = performance.now();
      schedule();
    } else if (!go && active.has(this)) {
      active.delete(this);
      this.renderer?.trim(this.index);                         // на паузе в памяти только показанный кадр
    }
    if (!go && this.renderer && ![...this.views].some((v) => v.visible)) this.renderer.drop();
    if (isHeavyAnimating()) wakeAfterHeavy();
  }

  advance(now) {
    if (!this.playable()) { this.update(); return; }
    const r = this.renderer;
    this.time += Math.min(now - this.last, 100);               // после долгого кадра не перескакиваем полсекунды
    this.last = now;
    const total = r.frames;
    let i = Math.floor((this.time * r.fps) / 1000 / r.step) * r.step;
    if (i >= total) {
      if (this.loops()) { this.time %= (total * 1000) / r.fps; i %= total; }
      else { i = total - 1; this.ended = true; active.delete(this); }
    }
    if (i !== this.index) this.show(i);
    const next = (i + r.step) % total;
    r.prefetch(next);                                          // на шаг вперёд — к следующему тику готов
  }

  show(i) {
    const r = this.renderer;
    if (!r) return;
    this.wanted = i;
    r.frame(i).then((bmp) => {
      if (this.closed || this.wanted !== i || !bmp) return;
      requestMutation(() => {
        if (this.closed || this.wanted !== i || !bmp.width) { r.done(i, bmp); return; }   // ширина 0 — кадр уже освобождён
        this.index = i;
        for (const v of this.views) v.draw(bmp);
        if (!this.shownOnce && i === 0) { this.shownOnce = true; savePreview(this.key, bmp); }
        r.done(i, bmp);
      });
    }, () => {});
  }

  attach(v) {
    this.views.add(v);
    if (this.renderer) {
      const bmp = this.renderer.cache.get(this.index);
      if (bmp) requestMutation(() => { if (bmp.width) v.draw(bmp); }); else this.show(this.index);
    }
    this.update();
  }

  /** Проиграть с начала (повтор по клику у героев настроек). */
  restart() {
    this.ended = false;
    this.time = 0;
    active.delete(this);
    this.update();
  }

  detach(v) {
    this.views.delete(v);
    if (this.views.size) { this.update(); return; }
    this.closed = true;
    active.delete(this);
    players.delete(this.key);
    this.renderer?.release();
  }
}

/**
 * Представление стикера (канвас). Возвращает управление: visible/play/loop меняются снаружи,
 * destroy() — при размонтировании. onFirstFrame — первый нарисованный кадр (снять подложку).
 */
export function attachSticker({ url, px, canvas, group = 'feed', play = true, loop, onFirstFrame, onError }) {
  const key = url + '|' + px;
  let pl = players.get(key);
  if (!pl) { pl = new Player(key, url, px); players.set(key, pl); }
  let first = true;
  const ctx = canvas.getContext('2d');
  canvas.width = px; canvas.height = px;
  const view = {
    group, play, loop, visible: false, onError,
    draw(bmp) {
      ctx.clearRect(0, 0, px, px);
      ctx.drawImage(bmp, 0, 0, px, px);
      if (first) { first = false; onFirstFrame?.(); }
    },
  };
  pl.attach(view);
  return {
    key,
    setVisible(v) { if (view.visible !== v) { view.visible = v; pl.update(); } },
    setPlay(v) { if (view.play !== v) { view.play = v; pl.update(); } },
    setLoop(v) { view.loop = v; },
    restart() { pl.restart(); },
    destroy() { pl.detach(view); },
  };
}

/** Отладка и тесты: сколько анимаций сейчас играет / живёт. */
export const stickerStats = () => ({ players: players.size, playing: active.size });
