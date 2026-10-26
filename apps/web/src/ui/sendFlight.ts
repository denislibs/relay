// «Полёт» отправленного, как в Telegram Web K / iOS: то, что ушло из поля ввода, перелетает в своё сообщение.
//
// Отправка снимает исходник (captureText: капсула поля и копия текста) в слой поверх экрана — поле под копией
// очищается незаметно. Новое своё сообщение ленты забирает ждущий полёт своего чата (claim) и прячется; launch
// ведёт клон пузыря из капсулы в его место у низа ленты: фон растёт по ширине и высоте (углы остаются круглыми),
// путь — дуга (по горизонтали и вертикали — разные кривые), 300 мс. Лента едет к низу те же 300 мс по той же
// вертикальной кривой (FLIGHT_SCROLL) — клон садится ровно на пиксели пузыря, и пузырь показывается вместо него.
// Без полной анимации (настройка «Анимации», reduced motion), со скрытой вкладкой и для пузыря выше экрана — не летим.
import { requestMeasure, requestMutation } from '@relay/ui';
import { getPrefs } from '../prefs';
import { bezier } from './scrollDrive';

export const FLIGHT_MS = 300;
const EASE_X = 'cubic-bezier(.23, 1, .32, 1)';
const EASE_Y = 'cubic-bezier(.1992, .0106, .2792, .9103)';
const HOLD_MS = 1500;      // пузырь так и не встал — копия гаснет
const GIVE_UP_MS = 150;

/** Вертикальная кривая полёта для прокрутки ленты (scrollDrive): те же точки, что EASE_Y. */
export const FLIGHT_SCROLL = { ms: FLIGHT_MS, curve: [0.1992, 0.0106, 0.2792, 0.9103] as const };

type Box = { left: number; top: number; width: number; height: number };
export type Flight = {
  chatId: number;
  box?: HTMLElement;   // стикер: снимок картинки из панели (летит, увеличиваясь до стикера сообщения)
  circle?: 'voice' | 'round';   // запись: круг кнопки отправки или превью кружка
  layer: HTMLElement;
  src: Box;            // капсула поля (фон вырастает из неё)
  first?: { left: number; top: number };   // первая буква текста в поле: на неё кладётся первая буква пузыря
  text: HTMLElement;   // копия текста поля (в слое, на своём месте)
  radius: string;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
  unfollow?: () => void;   // перестать догонять место посадки (follow)
  hold?: Animation;        // цель спрятана анимацией: перерисовка строки (сервер подтвердил) класс снимает, анимацию — нет
};

const pending: Flight[] = [];

/** Летать ли сейчас: полная анимация, движение не отключено системой, вкладка видна. */
export function canFly(): boolean {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const a = getPrefs().anim;
  return a.level === 2 && a.ui;
}

const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height });

function overlay(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'app-flight';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/**
 * Снять текстовую отправку до очистки поля: капсула и копия текста встают в слой на те же пиксели.
 * composer — капсула поля (.rl-composer), field — редактируемое поле. Вызывать синхронно в onSend.
 */
export function captureText(chatId: number, composer: Element | null, field: Element | null): void {
  if (!composer || !field || !canFly()) return;
  // чтение раскладки в обработчике отправки: поле ещё не очищено — это единственный момент, когда текст на месте
  const src = boxOf(composer.getBoundingClientRect()), fr = field.getBoundingClientRect();
  const cs = getComputedStyle(field);
  const range = document.createRange(); range.selectNodeContents(field);
  const gr = range.getClientRects()[0];
  const layer = overlay();
  const text = document.createElement('div');
  text.className = 'app-flight-text';
  // узлы поля, а не разметка строкой: без innerHTML (Trusted Types, вставленное из буфера)
  for (const n of Array.from(field.childNodes)) text.appendChild(n.cloneNode(true));
  Object.assign(text.style, {
    left: fr.left + 'px', top: fr.top + 'px', width: fr.width + 'px', height: fr.height + 'px',
    font: cs.font, lineHeight: cs.lineHeight, color: cs.color, padding: cs.padding, letterSpacing: cs.letterSpacing,
  });
  layer.appendChild(text);
  document.body.appendChild(layer);
  const f: Flight = { chatId, layer, src, text, first: gr ? { left: gr.left, top: gr.top } : undefined, radius: getComputedStyle(composer).borderRadius, claimed: false, timer: 0 as unknown as ReturnType<typeof setTimeout> };
  f.timer = setTimeout(() => giveUp(f), HOLD_MS);
  pending.push(f);
}

function drop(f: Flight): void {
  clearTimeout(f.timer);
  const i = pending.indexOf(f);
  if (i >= 0) pending.splice(i, 1);
}

export function giveUp(f: Flight): void {
  drop(f);
  f.unfollow?.();
  const a = f.layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: GIVE_UP_MS, fill: 'forwards' });
  a.onfinish = () => f.layer.remove();
}

// ---------- стикер: снимок нажатой ячейки панели ----------
// какая ячейка стикера нажата последней (меню «Стикеры», правая панель, окно пака): отправка идёт из onClick без
// элемента — берём его отсюда (захват на фазе погружения, раньше всех обработчиков)
const CELL = '.app-stk-cell, .app-stkrow-cell, .app-stkset-cell';
let pressed: Element | null = null;
if (typeof document !== 'undefined') document.addEventListener('pointerdown', (e) => { pressed = (e.target as Element | null)?.closest?.(CELL) ?? null; }, true);

/** Кадр стикера из ячейки: canvas (lottie / видео-стикер) копируем пикселями, картинку — клоном. */
function snapshot(media: Element): HTMLElement | null {
  const canvas = media.querySelector('canvas'), video = media.querySelector('video'), img = media.querySelector('img');
  const src = canvas ?? video;
  if (src) {
    const c = document.createElement('canvas');
    const w = canvas ? canvas.width : (video as HTMLVideoElement).videoWidth, h = canvas ? canvas.height : (video as HTMLVideoElement).videoHeight;
    if (!w || !h) return null;
    c.width = w; c.height = h;
    try { c.getContext('2d')?.drawImage(src as CanvasImageSource, 0, 0, w, h); } catch { return null; }
    return c;
  }
  return img ? (img.cloneNode(true) as HTMLElement) : null;
}

/** Снять отправку стикера: кадр нажатой ячейки встаёт в слой на её место. */
export function captureSticker(chatId: number): void {
  const cell = pressed;
  pressed = null;
  if (!cell || !cell.isConnected || !canFly()) return;
  const media = cell.querySelector('.rl-sticker') ?? cell;
  const r = media.getBoundingClientRect();
  const shot = snapshot(media);
  if (!shot || !r.width) return;
  const layer = overlay(), box = document.createElement('div');
  box.className = 'app-flight-box';
  Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  box.appendChild(shot);
  layer.appendChild(box);
  document.body.appendChild(layer);
  const text = document.createElement('div');   // пустая: у стикера текста нет
  const f: Flight = { chatId, layer, src: boxOf(r), text, box, radius: '0', claimed: false, timer: 0 as unknown as ReturnType<typeof setTimeout> };
  f.timer = setTimeout(() => giveUp(f), HOLD_MS);
  pending.push(f);
}

/**
 * Посадка в стикер или большое эмодзи (у них нет пузыря): летит снимок стикера (box) или копия текста поля —
 * дугой и с увеличением до блока .rl-sticker-box. Сообщение спрятано и показывается в момент посадки.
 */
export function launchBox(f: Flight, msg: HTMLElement, remaining: () => number): void {
  msg.classList.add('app-flight-target');
  // спрятан и анимацией: перерисовка строки (сервер подтвердил) класс снимает, анимацию — нет
  f.hold = msg.animate([{ opacity: 0 }, { opacity: 0 }], { duration: FLIGHT_MS * 5, fill: 'forwards' });
  // стикер сообщения подключаем сейчас: в полёте показывается его живая анимация (как в tweb летит сам стикер)
  const sticker = f.box ? msg.querySelector<HTMLElement>('.rl-sticker-box .rl-sticker') : null;
  if (sticker) { sticker.dataset.fly = '1'; sticker.dispatchEvent(new Event('rl-sticker-fly')); }   // метка — если стикер ещё не подписался
  requestMeasure(() => {
    const target = msg.querySelector<HTMLElement>('.rl-emoji-text') ?? msg.querySelector<HTMLElement>('.rl-sticker-box .rl-sticker') ?? msg.querySelector<HTMLElement>('.rl-sticker-box');
    if (!msg.isConnected || !target) { requestMutation(() => finish(f, msg)); return; }
    // эмодзи: место самих глифов в блоке (они по центру блока), как и у копии из поля — иначе в конце скачок
    let r = target.getBoundingClientRect();
    if (!f.box && target.classList.contains('rl-emoji-text')) { const rg = document.createRange(); rg.selectNodeContents(target); const gr = rg.getBoundingClientRect(); if (gr.width) r = gr; }
    const dy = remaining();
    const dst: Box = { left: r.left, top: r.top - dy, width: r.width, height: r.height };
    let src = f.src, flyer: HTMLElement, origin = '50% 50%';
    if (f.box) flyer = f.box;
    else {
      // копия текста поля: место и размер самих глифов (Range), а не всего поля; растёт от их центра
      const range = document.createRange(); range.selectNodeContents(f.text);
      const g = range.getBoundingClientRect(), t = f.text.getBoundingClientRect();
      if (!g.width) { requestMutation(() => finish(f, msg)); return; }
      src = boxOf(g); flyer = f.text;
      origin = `${g.left - t.left + g.width / 2}px ${g.top - t.top + g.height / 2}px`;
    }
    const k = dst.height / src.height;
    // как в tweb: центр едет дугой — по горизонтали (вместе с ростом) быстрая кривая, по вертикали медленная;
    // растёт от центра, а не от угла
    const dx = dst.left + dst.width / 2 - (src.left + src.width / 2), dyc = dst.top + dst.height / 2 - (src.top + src.height / 2);
    requestMutation(() => {
      const up = document.createElement('div');
      up.className = 'app-flight-up';
      flyer.replaceWith(up);
      up.appendChild(flyer);
      flyer.style.transformOrigin = origin;
      up.animate([{ transform: 'none' }, { transform: `translateY(${dyc}px)` }], { duration: FLIGHT_MS, easing: EASE_Y, fill: 'forwards' });
      const way = flyer.animate([{ transform: 'none' }, { transform: `translateX(${dx}px) scale(${k})` }], { duration: FLIGHT_MS, easing: EASE_X, fill: 'forwards' });
      follow(f, target, dst.top, remaining);
      if (sticker && f.box) mirror(f, f.box, sticker);   // после follow: снимает свою остановку поверх его
      landWhen(way, () => finish(f, msg));
    });
  });
}

/**
 * В летящий стикер — живые кадры стикера сообщения: пока его анимация не нарисовала первый кадр, виден снимок
 * ячейки панели; как нарисовала — каждый кадр копируем её канвас поверх, снимок гаснет за 80 мс (как в tweb).
 */
function mirror(f: Flight, box: HTMLElement, sticker: HTMLElement): void {
  const live = document.createElement('canvas');
  live.className = 'app-flight-live';
  box.appendChild(live);
  const shot = box.firstElementChild as HTMLElement | null;
  let on = true, shown = false;
  const prev = f.unfollow;
  f.unfollow = () => { on = false; prev?.(); };
  const frame = () => {
    if (!on) return;
    const src = sticker.querySelector<HTMLCanvasElement>('canvas.rl-sticker-canvas');
    if (src && sticker.dataset.drawn && src.width) {
      if (live.width !== src.width) { live.width = src.width; live.height = src.height; }
      const ctx = live.getContext('2d');
      if (ctx) { ctx.clearRect(0, 0, live.width, live.height); ctx.drawImage(src, 0, 0); }
      if (!shown) { shown = true; if (shot && shot !== live) shot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 80, fill: 'forwards' }); }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------- голосовое и кружок: круг из поля в сообщение ----------
/**
 * Снять отправку записи: голосовое — кнопка отправки (круг цвета кнопки летит в кнопку «играть»), кружок — превью
 * записи (кадр видео в круге летит в кружок сообщения).
 */
export function captureCircle(chatId: number, el: Element | null, kind: 'voice' | 'round'): void {
  if (!el || !el.isConnected || !canFly()) return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  const box = document.createElement('div');
  box.className = 'app-flight-box app-flight-circle';
  Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  if (kind === 'voice') {
    // как в tweb: круг непрозрачный, в нём копия кнопки отправки (микрофон), которая по пути уступает «играть»
    box.style.background = getComputedStyle(el).backgroundColor;
    const icon = controlCopy(el);
    icon.classList.add('app-flight-from');
    box.appendChild(icon);
  } else {
    const v = el.querySelector('video'), shot = v ? snapshot(el) : null;
    if (shot) box.appendChild(shot); else box.style.background = '#000';
  }
  const layer = overlay();
  layer.appendChild(box);
  document.body.appendChild(layer);
  const f: Flight = { chatId, layer, src: boxOf(r), text: document.createElement('div'), box, circle: kind, radius: '50%', claimed: false, timer: 0 as unknown as ReturnType<typeof setTimeout> };
  f.timer = setTimeout(() => giveUp(f), HOLD_MS);
  pending.push(f);
}

/**
 * Копия значка круглой кнопки: фон и цвет — снятые со стиля (копия живёт вне ленты, классы там не действуют),
 * видимый значок — клоном svg своего размера, по центру. Кладётся в летящий круг на всю его площадь.
 */
function controlCopy(el: Element): HTMLElement {
  const cs = getComputedStyle(el);
  const copy = document.createElement('div');
  copy.className = 'app-flight-icon';
  copy.style.background = cs.backgroundColor;
  copy.style.color = cs.color;
  // видимость не смотрим: кнопка-цель на время полёта спрятана (visibility), а значок нужен её
  const svg = Array.from(el.querySelectorAll('svg')).find((g) => { const r = g.getBoundingClientRect(), gs = getComputedStyle(g); return r.width > 0 && gs.display !== 'none' && gs.opacity !== '0'; });
  if (svg) {
    const r = svg.getBoundingClientRect(), g = svg.cloneNode(true) as SVGElement;
    g.style.width = r.width + 'px'; g.style.height = r.height + 'px';
    g.removeAttribute('class');
    copy.appendChild(g);
  }
  return copy;
}

/**
 * Посадка круга: в кнопку «играть» голосового или в кружок. Путь — как у пузыря: по горизонтали (сдвиг и размер)
 * быстрая кривая, по вертикали медленная. Голосовое — как в tweb: круг непрозрачный, микрофон по пути перетекает
 * в «играть», круг садится на кнопку и уступает ей место. Кружок: кадр видео гаснет, проявляется сам кружок.
 */
export function launchCircle(f: Flight, target: HTMLElement, remaining: () => number): void {
  target.classList.add('app-flight-target');
  const row = target.closest('.app-msg');
  row?.classList.add('app-flight-row');
  requestMeasure(() => {
    if (!target.isConnected || !f.box) { requestMutation(() => finish(f, target)); return; }
    const r = target.getBoundingClientRect(), dy = remaining();
    const dst: Box = { left: r.left, top: r.top - dy, width: r.width, height: r.height }, src = f.src;
    const voice = f.circle === 'voice', to = voice ? controlCopy(target) : null;
    requestMutation(() => {
      const box = f.box!;
      const dx = dst.left + dst.width / 2 - (src.left + src.width / 2), dy2 = dst.top + dst.height / 2 - (src.top + src.height / 2);
      // вертикаль — обёртка (медленная кривая), горизонталь и размер — сам круг от центра (быстрая)
      const up = document.createElement('div');
      up.className = 'app-flight-up';
      box.replaceWith(up);
      up.appendChild(box);
      box.style.transformOrigin = '50% 50%';
      up.animate([{ transform: 'none' }, { transform: `translateY(${dy2}px)` }], { duration: FLIGHT_MS, easing: EASE_Y, fill: 'forwards' });
      const way = box.animate([{ transform: 'none' }, { transform: `translateX(${dx}px) scale(${dst.width / src.width}, ${dst.height / src.height})` }], { duration: FLIGHT_MS, easing: EASE_X, fill: 'forwards' });
      if (voice && to) {
        f.hold = target.animate([{ opacity: 0 }, { opacity: 0 }], { duration: FLIGHT_MS * 5, fill: 'forwards' });
        // микрофон уступает «играть» по ходу пути вниз (как в tweb); сам круг не гаснет — садится и меняется на кнопку
        to.classList.add('app-flight-to');
        box.appendChild(to);
        box.animate([{ backgroundColor: getComputedStyle(box).backgroundColor }, { backgroundColor: to.style.background }], { duration: FLIGHT_MS, easing: EASE_Y, fill: 'forwards' });
        box.querySelector<HTMLElement>('.app-flight-from')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLIGHT_MS, easing: EASE_Y, fill: 'forwards' });
        to.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FLIGHT_MS, easing: EASE_Y, fill: 'forwards' });
      } else {
        // кружок: кадр записи гаснет к концу, сам кружок проявляется под ним
        box.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: FLIGHT_MS, fill: 'forwards' });
        const reveal = target.animate([{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: FLIGHT_MS, fill: 'backwards' });
        reveal.ready.then(() => requestMutation(() => target.classList.remove('app-flight-target')));
      }
      follow(f, target, dst.top, remaining);
      landWhen(way, () => finish(f, target));
    });
  });
}

/** Новое своё сообщение чата забирает самый ранний ждущий полёт этого чата. */
export function claim(chatId: number): Flight | null {
  const f = pending.find((x) => x.chatId === chatId && !x.claimed);
  if (!f) return null;
  f.claimed = true;
  clearTimeout(f.timer);
  return f;
}

/**
 * Полёт к пузырю. bubble — настоящий пузырь (уже в ленте, спрятан на время полёта); remaining() — сколько ленте
 * ещё ехать вниз (её прокрутка идёт параллельно по той же кривой): место посадки = нынешнее место − этот путь.
 */
export function launch(f: Flight, bubble: HTMLElement, remaining: () => number): void {
  bubble.classList.add('app-flight-target');   // прячем сразу, до замера: иначе мелькнёт кадр с пузырём и копией
  // обычное появление строки (выезд снизу на 2rem) сдвигало бы место посадки — у летящей его нет
  const row = bubble.closest('.app-msg');
  row?.classList.add('app-flight-row');
  requestMeasure(() => {
    if (!bubble.isConnected) { drop(f); f.layer.remove(); return; }
    const r = bubble.getBoundingClientRect(), dy = remaining();
    const dst: Box = { left: r.left, top: r.top - dy, width: r.width, height: r.height };
    const bs = getComputedStyle(bubble);
    // пузырь выше экрана — лететь некуда: просто показываем
    if (dst.height > innerHeight * 0.9) { requestMutation(() => { finish(f, bubble); }); return; }
    // как в tweb: текст пузыря с первого кадра лежит на тексте поля (первая буква на первой букве) и летит вместе
    // с ним — два текста не расходятся. Фон вырастает из капсулы поля и садится на пузырь; время и галочки
    // проявляются по пути. Пути — на тех же кривых по осям, поэтому текст всё время внутри растущего фона
    const glyph = bubble.querySelector('.rl-bubble-text');
    const range = glyph && document.createRange();
    range?.selectNodeContents(glyph!);
    const bf = range?.getClientRects()[0];
    const from = f.first && bf
      ? { left: f.first.left - (bf.left - r.left), top: f.first.top - (bf.top - r.top) }
      : { left: f.src.left, top: f.src.top };
    requestMutation(() => {
      const opts = (easing: string, extra: KeyframeAnimationOptions = {}) => ({ duration: FLIGHT_MS, easing, fill: 'forwards' as const, ...extra });
      const axes = (left: number, top: number, dx: number, dy: number) => {
        const x = document.createElement('div'), y = document.createElement('div');
        x.className = 'app-flight-x'; y.className = 'app-flight-y';
        Object.assign(x.style, { left: left + 'px', top: top + 'px' });
        x.appendChild(y);
        x.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], opts(EASE_X));
        y.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], opts(EASE_Y));
        return { x, y };
      };
      // фон: капсула → пузырь. Ось — целиком на своей кривой: по горизонтали левый край и ширина вместе (быстрая),
      // по вертикали верх и высота вместе (медленная). Иначе левый край убегает вперёд ширины, и правый край
      // раздувается за колонку (было до ~190 px). Так правый и нижний края идут ровно от капсулы к пузырю
      const bg = document.createElement('div');
      bg.className = 'app-flight-bg';
      bg.style.background = bs.backgroundColor;
      bg.style.boxShadow = bs.boxShadow;
      bg.animate([
        { left: f.src.left + 'px', width: f.src.width + 'px' },
        { left: dst.left + 'px', width: dst.width + 'px' },
      ], opts(EASE_X));
      const way = bg.animate([
        { top: f.src.top + 'px', height: f.src.height + 'px', borderRadius: f.radius },
        { top: dst.top + 'px', height: dst.height + 'px', borderRadius: bs.borderRadius },
      ], opts(EASE_Y));
      bg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, fill: 'forwards' });
      // время и галочки едут на правом нижнем углу фона, а не с текстом: копия пузыря, где видно только их, движется
      // так, что её угол всё время совпадает с углом фона (те же кривые по осям)
      const corner = axes(dst.left, dst.top, f.src.left + f.src.width - dst.width - dst.left, f.src.top + f.src.height - dst.height - dst.top);
      const metaCopy = bubble.cloneNode(true) as HTMLElement;
      metaCopy.classList.remove('app-flight-target', 'rl-appear-out', 'rl-appear-in');
      metaCopy.classList.add('app-flight-body', 'app-flight-meta');
      Object.assign(metaCopy.style, { width: dst.width + 'px', height: dst.height + 'px', boxSizing: 'border-box', animation: 'none', background: 'transparent', boxShadow: 'none' });
      corner.y.appendChild(metaCopy);
      metaCopy.querySelector<HTMLElement>('.rl-bubble-meta')?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.2 }, { opacity: 1 }], { duration: FLIGHT_MS * 0.9, fill: 'backwards' });
      // содержимое пузыря (без фона): от текста поля к своему месту
      const front = axes(dst.left, dst.top, from.left - dst.left, from.top - dst.top);
      const body = bubble.cloneNode(true) as HTMLElement;
      body.classList.remove('app-flight-target', 'rl-appear-out', 'rl-appear-in');
      body.classList.add('app-flight-body');
      Object.assign(body.style, { width: dst.width + 'px', height: dst.height + 'px', boxSizing: 'border-box', animation: 'none', background: 'transparent', boxShadow: 'none' });
      front.y.appendChild(body);
      body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 80, fill: 'backwards' });
      // текст поля летит тем же путём, что текст пузыря, и гаснет за 100 мс — его сменяет такой же
      const field = axes(0, 0, 0, 0);
      field.x.animate([{ transform: 'none' }, { transform: `translateX(${dst.left - from.left}px)` }], opts(EASE_X));
      field.y.animate([{ transform: 'none' }, { transform: `translateY(${dst.top - from.top}px)` }], opts(EASE_Y));
      field.y.appendChild(f.text);
      f.text.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: 'forwards' });
      f.layer.append(bg, corner.x, front.x, field.x);
      follow(f, bubble, dst.top, remaining);
      landWhen(way, () => finish(f, bubble));
    });
  });
}

const curveY = bezier(...FLIGHT_SCROLL.curve);

/**
 * Место посадки сдвинулось по дороге (дорисовался стикер, выросло поле ввода, пришло ещё сообщение) — слой плавно
 * догоняет его, а не прыгает в конце: смещение растёт к новому месту, к концу пути — целиком. Пока место то же,
 * ничего не пишем. Кадр — одно чтение (measure) и одна запись (mutation).
 */
function follow(f: Flight, el: HTMLElement, top: number, remaining: () => number): void {
  const t0 = performance.now();
  let on = true, applied = 0;
  f.unfollow = () => { on = false; };
  const tick = () => requestMeasure(() => {
    if (!on || !el.isConnected) return;
    const delta = el.getBoundingClientRect().top - remaining() - top;   // где пузырь встанет, когда лента доедет
    const p = Math.min(1, (performance.now() - t0) / FLIGHT_MS);
    const next = applied + (delta - applied) * Math.max(0.35, curveY(p));
    requestMutation(() => {
      if (!on) return;
      if (Math.abs(next - applied) > 0.25 || (Math.abs(next) > 0.25) !== (Math.abs(applied) > 0.25)) {
        applied = next;
        f.layer.style.transform = Math.abs(applied) > 0.25 ? `translateY(${applied}px)` : '';
      }
      tick();
    });
  });
  tick();
}

/**
 * Посадка — по концу самого полёта, а не по таймеру: если главный поток занят (сообщение со стикером рисуется
 * сотни миллисекунд), анимация стартует позже, и таймер снимал копию на полпути — стикер появлялся рывком
 */
function landWhen(way: Animation, land: () => void): void {
  let done = false;
  const go = () => { if (!done) { done = true; requestMutation(land); } };
  way.finished.then(go, go);
  setTimeout(go, FLIGHT_MS * 4);   // анимацию отменили или вкладку спрятали — не держим копию вечно
}

function finish(f: Flight, el: HTMLElement): void {
  drop(f);
  f.unfollow?.();
  f.hold?.cancel();
  const row = el.closest<HTMLElement>('.app-msg');
  el.classList.remove('app-flight-target');
  row?.classList.remove('app-flight-row');
  // снятое подавление запускает появление строки (rl-msg-in: из прозрачности и на 2rem снизу) заново — пузырь
  // гас и выезжал второй раз сразу после посадки. Доводим его до конца в том же кадре, до отрисовки
  for (const n of [el, ...(row ? [row, ...row.querySelectorAll<HTMLElement>('.rl-appear-out, .rl-appear-in')] : [])]) {
    for (const a of n.getAnimations()) if ((a as CSSAnimation).animationName === 'rl-msg-in') a.finish();
  }
  f.layer.remove();
  // у стикера и эмодзи прятали всё сообщение: время и ответ проявляются после посадки, как в Telegram
  if (el.classList.contains('rl-sticker-msg')) for (const part of el.querySelectorAll<HTMLElement>('.rl-sticker-meta, .rl-sticker-head')) part.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
}

/** Для тестов: ждущие полёты. */
export const pendingFlights = (): readonly { chatId: number; claimed: boolean }[] => pending;
