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
  constructor(key, url, px, atEnd = false) {
    this.key = key; this.url = url; this.px = px;
    this.atEnd = atEnd;      // стоит на последнем кадре, пока не restart() (исход старого броска)
    this.views = new Set();
    this.renderer = null;
    this.index = 0;          // показанный кадр
    this.time = 0;           // мс проигранного времени (на паузе стоит)
    this.last = 0;           // performance.now() прошлого шага
    this.ended = false;
    this.finished = false;       // onEnded уже вызван
    this.wanted = -1;        // кадр, который ждём из воркера
    this.shownOnce = false;
    this.closed = false;
    const start = () => {
      if (this.closed) return;
      openRenderer({ url, px }).then((r) => {
        if (this.closed) { r.release(); return; }
        this.renderer = r;
        if (this.atEnd) { this.ended = true; this.finished = true; this.time = (r.frames * 1000) / r.fps; this.show(r.frames - 1); }
        else this.show(0);   // первый кадр сразу — даже если играть нельзя
        this.update();
      }, () => { for (const v of this.views) v.onError?.(); });
    };
    this.start = start;
    this.starting = false;
  }

  /** Открыть рендерер: во время тяжёлой анимации (открытие панели, модалки) ждём её конца — WASM и сеть подождут;
   *  вид с force (эффект, панель реакций) открывает сразу. */
  begin(force) {
    if (this.starting) return;
    if (!force && isHeavyAnimating()) { onHeavyAnimationEnd(() => { if (!this.starting) { this.starting = true; this.start(); } }); return; }
    this.starting = true;
    this.start();
  }

  playable() {
    if (!this.renderer || !focused || this.atEnd) return false;   // atEnd стоит на исходе до restart()
    // force — эффекты и панель реакций: играют и во время тяжёлой анимации, и при выключенном автоплее, и под
    // эксклюзивной группой (меню открывается с beginHeavyAnimation, иначе «появление» ждало бы его конца)
    for (const v of this.views) if (v.visible && v.play && v.force) return true;
    if (!policy.autoplay || isHeavyAnimating()) return false;
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
      if (this.ended) { this.ended = false; this.finished = false; this.time = 0; }   // снова на экране — проигрываем заново
      active.add(this);
      this.last = performance.now();
      schedule();
    } else if (!go && active.has(this)) {
      active.delete(this);
      this.needTrim = true;
    }
    // на паузе в памяти только показанный кадр, но освобождаем кэш не посреди тяжёлой анимации (её начало и ставит
    // плееры на паузу — trim/drop попадали в кадры движения); после неё update() позовут снова (wakeAfterHeavy)
    const heavy = isHeavyAnimating();
    if (!go && this.needTrim && !heavy) { this.needTrim = false; this.renderer?.trim(this.index); }
    if (!go && this.renderer && !heavy && ![...this.views].some((v) => v.visible)) this.renderer.drop();
    if (heavy) wakeAfterHeavy();
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
    else if (this.ended) this.finish();
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
        if (this.ended && i === r.frames - 1) this.finish();
        if (!this.shownOnce && i === 0) { this.shownOnce = true; savePreview(this.key, bmp); }
        r.done(i, bmp);
      });
    }, () => {});
  }

  attach(v) {
    this.views.add(v);
    this.begin(v.force);
    if (this.renderer) {
      const bmp = this.renderer.cache.get(this.index);
      if (bmp) requestMutation(() => { if (bmp.width) v.draw(bmp); }); else this.show(this.index);
    }
    this.update();
  }

  /** Последний кадр без цикла показан: onEnded каждого вида — один раз, пока не restart(). */
  finish() {
    if (this.finished) return;
    this.finished = true;
    for (const v of this.views) v.onEnded?.();
  }

  /** Проиграть с начала (повтор по клику у героев настроек). */
  restart() {
    this.atEnd = false;
    this.ended = false;
    this.finished = false;
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
 * destroy() — при размонтировании. onFirstFrame — первый нарисованный кадр (снять подложку). onEnded — без цикла
 * показан последний кадр (один раз до restart). force — играть вопреки тяжёлой анимации, автоплею и эксклюзивной группе.
 * shared:false — отдельный плеер (свои часы) даже при том же url и размере. atEnd — сразу последний кадр и стоп
 * (только со shared:false: у общего плеера часы общие).
 */
let privateSeq = 0;

// Последний нарисованный кадр каждого адреса — у любого размера. Стикер, который уже виден в одном месте (панель,
// 64 px), в другом (лента, 200 px) открывает свой рендерер и ждёт кадр из воркера; пока ждёт — вместо силуэта
// показываем этот кадр. Живые канвасы — как есть; ушедший канвас оставляет копию (последние LAST_MAX адресов)
const liveCanvases = new Map();   // url → Set<canvas>
const lastCopies = new Map();     // url → canvas (копия последнего кадра)
const LAST_MAX = 24;
function keepCopy(url, canvas) {
  if (!canvas.width || typeof document === 'undefined') return;
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  try { c.getContext('2d').drawImage(canvas, 0, 0); } catch { return; }
  lastCopies.delete(url);
  lastCopies.set(url, c);
  while (lastCopies.size > LAST_MAX) lastCopies.delete(lastCopies.keys().next().value);
}
/** Кадр этого стикера, уже нарисованный где-то ещё (канвас или его копия), или null. */
export function drawnFrame(url) {
  for (const c of liveCanvases.get(url) ?? []) if (c.isConnected && c.width) return c;
  return lastCopies.get(url) ?? null;
}

export function attachSticker({ url, px, canvas, group = 'feed', play = true, loop, force = false, shared = true, atEnd = false, onFirstFrame, onEnded, onError }) {
  // shared:false — свои часы (эффекты реакций: две копии одной анимации не должны стартовать с середины
  // и заканчиваться вместе); рендерер и кэш кадров всё равно общие (pool)
  const key = url + '|' + px + (shared ? '' : '|#' + ++privateSeq);
  let pl = players.get(key);
  if (!pl) { pl = new Player(key, url, px, !shared && atEnd); players.set(key, pl); }
  let first = true;
  const ctx = canvas.getContext('2d');
  canvas.width = px; canvas.height = px;
  const view = {
    group, play, loop, force, visible: false, onError, onEnded,
    draw(bmp) {
      ctx.clearRect(0, 0, px, px);
      ctx.drawImage(bmp, 0, 0, px, px);
      if (first) {
        first = false;
        let set = liveCanvases.get(url);
        if (!set) liveCanvases.set(url, (set = new Set()));
        set.add(canvas);
        onFirstFrame?.();
      }
    },
  };
  pl.attach(view);
  return {
    key,
    setVisible(v) { if (view.visible !== v) { view.visible = v; pl.update(); } },
    setPlay(v) { if (view.play !== v) { view.play = v; pl.update(); } },
    setLoop(v) { view.loop = v; },
    restart() { pl.restart(); },
    destroy() {
      pl.detach(view);
      const set = liveCanvases.get(url);
      if (set?.delete(canvas)) { keepCopy(url, canvas); if (!set.size) liveCanvases.delete(url); }
    },
  };
}

/** Отладка и тесты: сколько анимаций сейчас играет / живёт. */
export const stickerStats = () => ({ players: players.size, playing: active.size });

/** Подробно для раздела разработчика: виды (канвасы), видимые, ждущие рендерер и играющие — по группам. */
export function stickerDetail() {
  let views = 0, visible = 0, loading = 0;
  const groups = {};   // группа → { views, playing }
  for (const pl of players.values()) {
    if (!pl.renderer) loading++;
    const on = active.has(pl);
    for (const v of pl.views) {
      views++;
      if (v.visible) visible++;
      const g = (groups[v.group] ??= { views: 0, playing: 0 });
      g.views++;
      if (on && v.visible) g.playing++;
    }
  }
  return { players: players.size, playing: active.size, loading, views, visible, groups, exclusive, policy: { ...policy } };
}
