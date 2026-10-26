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
  layer: HTMLElement;
  src: Box;            // капсула поля (фон вырастает из неё)
  text: HTMLElement;   // копия текста поля (в слое, на своём месте)
  radius: string;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
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
  const f: Flight = { chatId, layer, src, text, radius: getComputedStyle(composer).borderRadius, claimed: false, timer: 0 as unknown as ReturnType<typeof setTimeout> };
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
  const a = f.layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: GIVE_UP_MS, fill: 'forwards' });
  a.onfinish = () => f.layer.remove();
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
    requestMutation(() => {
      const fx = document.createElement('div'), fy = document.createElement('div'), bg = document.createElement('div');
      fx.className = 'app-flight-x'; fy.className = 'app-flight-y'; bg.className = 'app-flight-bg';
      Object.assign(fx.style, { left: dst.left + 'px', top: dst.top + 'px' });
      bg.style.background = bs.backgroundColor;
      bg.style.boxShadow = bs.boxShadow;
      // клон пузыря в итоговой раскладке: растущий фон открывает его (overflow hidden), время и цитата — на своих местах
      const body = bubble.cloneNode(true) as HTMLElement;
      body.classList.remove('app-flight-target');
      body.classList.add('app-flight-body');
      Object.assign(body.style, { width: dst.width + 'px', height: dst.height + 'px', animation: 'none', background: 'transparent', boxShadow: 'none' });
      bg.appendChild(body);
      fy.appendChild(bg); fx.appendChild(fy); f.layer.appendChild(fx);
      const opts = (easing: string, extra: KeyframeAnimationOptions = {}) => ({ duration: FLIGHT_MS, easing, fill: 'forwards' as const, ...extra });
      fx.animate([{ transform: `translateX(${f.src.left - dst.left}px)` }, { transform: 'none' }], opts(EASE_X));
      fy.animate([{ transform: `translateY(${f.src.top - dst.top}px)` }, { transform: 'none' }], opts(EASE_Y));
      bg.animate([
        { width: f.src.width + 'px', height: f.src.height + 'px', borderRadius: f.radius },
        { width: dst.width + 'px', height: dst.height + 'px', borderRadius: bs.borderRadius },
      ], opts(EASE_Y));
      bg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, fill: 'forwards' });
      body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 80, fill: 'backwards' });
      // текст поля улетает вместе с фоном и гаснет за 100 мс (его сменяет текст пузыря)
      const tx = f.src.left - dst.left, ty = f.src.top - dst.top;
      f.text.animate([
        { transform: 'none', opacity: 1 },
        { opacity: 0, offset: 100 / FLIGHT_MS },
        { transform: `translate(${-tx}px, ${-ty}px)`, opacity: 0 },
      ], { duration: FLIGHT_MS, easing: EASE_Y, fill: 'forwards' });
      setTimeout(() => requestMutation(() => finish(f, bubble)), FLIGHT_MS + 16);
    });
  });
}

function finish(f: Flight, bubble: HTMLElement): void {
  drop(f);
  bubble.classList.remove('app-flight-target');
  bubble.closest('.app-msg')?.classList.remove('app-flight-row');
  f.layer.remove();
}

/** Для тестов: ждущие полёты. */
export const pendingFlights = (): readonly { chatId: number; claimed: boolean }[] => pending;
