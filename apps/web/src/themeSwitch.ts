import { beginHeavyAnimation, flushFrames, reducedMotion, requestMutation } from '@relay/ui';
import tokens from '@relay/ui/tokens.json';
import { paletteCss } from './themes/palette';
// Смена темы: новая тема раскрывается кругом из точки нажатия (View Transitions, как в мобильном Telegram).
// Где View Transitions нет — и для смены акцента — цвета токенов смешиваются на <html> кадр за кадром
// (≈200 мс), а обои тают вместе с ними (Wallpaper в relay-ui). Остальные transition на это время выключены
// (.rl-theme-switching): иначе каждый элемент переливался бы по-своему.

type Rgba = [number, number, number, number];
type Theme = 'light' | 'dark';

function parseColor(c: string): Rgba | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c.trim());
  if (hex) {
    let x = hex[1];
    if (x.length <= 4) x = [...x].map((ch) => ch + ch).join('');
    const n = (i: number) => parseInt(x.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), x.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(c.trim());
  if (fn) {
    const p = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.every(Number.isFinite)) return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return null;
}

const BASE = tokens.color.tokens as { name: string; value: string | { light: string; dark: string } }[];

/** Цвета всех токенов стороны с поверх положенной палитрой темы (themes/palette.ts) — то, что будет на экране. */
function palette(theme: Theme, over: Record<string, string>): Map<string, Rgba> {
  const out = new Map<string, Rgba>();
  for (const t of BASE) {
    const raw = over[t.name] ?? (typeof t.value === 'string' ? t.value : t.value[theme]);
    const c = parseColor(raw);
    if (c) out.set('--' + t.name, c);
  }
  return out;
}

const DURATION_MS = 200;
const ease = (t: number) => 1 - (1 - t) ** 3.5;   // быстрый старт, мягкая посадка
let running = 0;
let blended: string[] = [];   // какие свойства сейчас стоят инлайном

const rgba = (c: Rgba) => `rgba(${c[0]},${c[1]},${c[2]},${c[3]})`;
const setAttr = (root: HTMLElement, theme: Theme | null) => { if (theme === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme); };
const clear = (root: HTMLElement) => { for (const n of blended) root.style.removeProperty(n); blended = []; root.classList.remove('rl-theme-switching'); };
const themeNow = (root: HTMLElement): Theme => {
  const attr = root.getAttribute('data-theme');
  return (attr ? attr === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
};

/**
 * Смешивание from → to. swap() — настоящее переключение (атрибут темы или стиль акцента): делается
 * в первом кадре, когда инлайн уже держит старые цвета, поэтому скачка нет. Новый вызов прерывает старый.
 */
/** Палитра окончательно сменилась (тема или акцент). Кто рисует на canvas и запомнил цвета — перечитывает их. */
function paletteChanged(): void { requestMutation(() => dispatchEvent(new Event('rl:palette'))); }

// цвета обоев не смешиваются: обои читают их сразу после смены и тают снимком (иначе полпути — rgba, а не hex)
const NOT_BLENDED = /^--wallpaper/;

function blend(root: HTMLElement, from: Map<string, Rgba>, to: Map<string, Rgba>, swap: () => void, animate: boolean): void {
  const run = ++running;
  stopCircle();
  const names = [...to.keys()].filter((n) => { const a = from.get(n), b = to.get(n)!; return !NOT_BLENDED.test(n) && a && a.some((x, i) => x !== b[i]); });
  if (!animate || reducedMotion() || !names.length) {
    requestMutation(() => { if (run !== running) return; clear(root); swap(); paletteChanged(); });   // прерванное смешивание не оставляет переопределений
    return;
  }
  const end = beginHeavyAnimation(DURATION_MS + 100);   // цвета всей страницы меняются — тяжёлая анимация
  const start = performance.now();
  const frame = () => requestMutation(() => {
    if (run !== running) { end(); return; }             // поверх началась новая смена
    const t = Math.min(1, (performance.now() - start) / DURATION_MS);
    if (t >= 1) { clear(root); end(); paletteChanged(); return; }
    const k = ease(t);
    for (const n of names) {
      const a = from.get(n)!, b = to.get(n)!;
      const c = (i: number) => Math.round(a[i] + (b[i] - a[i]) * k);
      root.style.setProperty(n, `rgba(${c(0)},${c(1)},${c(2)},${+(a[3] + (b[3] - a[3]) * k).toFixed(3)})`);
    }
    frame();
  });
  requestMutation(() => {
    if (run !== running) { end(); return; }
    clear(root);
    root.classList.add('rl-theme-switching');
    for (const n of names) root.style.setProperty(n, rgba(from.get(n)!));
    blended = names;
    swap();
    frame();
  });
}

// ---------- круг из точки нажатия ----------

const CIRCLE_MS = 450;
type VT = { ready: Promise<void>; finished: Promise<void>; skipTransition(): void };
type DocVT = Document & { startViewTransition?: (cb: () => void | Promise<void>) => VT };
let circle: VT | null = null;

// где нажали последний раз: переключатель темы в меню или в настройках
let lastPoint: { x: number; y: number; t: number; toggle: boolean } | null = null;
// Пока идёт View Transition, браузер отдаёт все нажатия <html> (pointer-events не помогает): интерфейс
// полсекунды глух — это ощущается как фриз. Нажатие во время круга досрочно завершает его, а клик
// доставляется элементу под курсором, когда страница снова настоящая.
let tapDuringCircle: { x: number; y: number; done: Promise<void> } | null = null;
if (typeof addEventListener === 'function') {
  addEventListener('pointerdown', (e: PointerEvent) => {
    lastPoint = { x: e.clientX, y: e.clientY, t: performance.now(), toggle: e.target instanceof Element && !!e.target.closest('[data-theme-toggle]') };
    if (!circle) return;
    tapDuringCircle = { x: e.clientX, y: e.clientY, done: circle.finished.catch(() => {}) };
    stopCircle();
  }, { capture: true, passive: true });
  addEventListener('click', (e: MouseEvent) => {
    const tap = tapDuringCircle;
    tapDuringCircle = null;
    if (!tap || e.target !== document.documentElement) return;
    e.stopPropagation();
    void tap.done.then(() => {
      const el = document.elementFromPoint(tap.x, tap.y);
      if (el instanceof HTMLElement && el !== document.documentElement) { el.focus({ preventScroll: true }); el.click(); }
    });
  }, { capture: true });
}

/** Центр круга: недавнее нажатие; с клавиатуры — элемент в фокусе; иначе центр окна. */
export function circleOrigin(now = performance.now()): { x: number; y: number } {
  if (lastPoint && now - lastPoint.t < 1500) return { x: lastPoint.x, y: lastPoint.y };
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (a && a !== document.body && a instanceof HTMLElement) { const r = a.getBoundingClientRect(); if (r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  return { x: innerWidth / 2, y: innerHeight / 2 };
}

/** Радиус, при котором круг из (x, y) закрывает всё окно w×h. */
export const circleRadius = (x: number, y: number, w: number, h: number): number => Math.hypot(Math.max(x, w - x), Math.max(y, h - y));

function stopCircle() { circle?.skipTransition(); circle = null; }

/** Есть View Transitions и движение не урезано — смена темы кругом. */
const canCircle = () => typeof (document as DocVT).startViewTransition === 'function' && !reducedMotion();

/**
 * clip-path круга в процентах от снимка. Пиксели не годятся: часть версий Chromium считала их в пикселях
 * подложки (на Retina круг уезжал к половине координаты нажатия); проценты везде считаются от размера снимка.
 * Процент радиуса у circle() — от диагонали, делённой на √2.
 */
export function circleClip(x: number, y: number, radius: number, w: number, h: number): string {
  const pct = (v: number) => +v.toFixed(3) + '%';
  return `circle(${pct(radius / (Math.hypot(w, h) / Math.SQRT2) * 100)} at ${pct(x / w * 100)} ${pct(y / h * 100)})`;
}

const STUCK_MS = 2000;   // переход завис (браузер не дождался кадра и т. п.) — завершить, страница не остаётся снимком

function circleSwitch(root: HTMLElement, swap: () => void, toDark: boolean): void {
  running++;            // прервать смешивание, если шло
  clear(root);
  stopCircle();
  const { x, y } = circleOrigin();
  // в тёмную — тёмный круг растёт из точки нажатия. В светлую с кнопки-переключателя (data-theme-toggle, экран
  // входа) тёмный круг сжимается обратно в неё; из списка тем в настройках — светлый круг растёт, как обычно
  const fromToggle = !!lastPoint?.toggle && performance.now() - lastPoint.t < 1500;
  const grow = toDark || !fromToggle;
  const end = beginHeavyAnimation(CIRCLE_MS + 150);
  root.classList.add('rl-theme-vt');
  root.classList.toggle('rl-theme-shrink', !grow);
  const t = (document as DocVT).startViewTransition!(() => {
    swap();
    // браузер ждёт новое состояние и не даёт кадров (requestAnimationFrame молчит): перерисовка темы и
    // обоев — сейчас, иначе в круге сначала окажутся старые обои
    flushFrames(6);
  });
  circle = t;
  const stuck = setTimeout(() => t.skipTransition(), STUCK_MS);
  let anim: Animation | null = null;
  t.ready.then(() => {
    const pseudo = grow ? '::view-transition-new(root)' : '::view-transition-old(root)';
    const box = getComputedStyle(root, pseudo);
    const w = parseFloat(box.width) || innerWidth, h = parseFloat(box.height) || innerHeight;
    const from = circleClip(x, y, 0, w, h), to = circleClip(x, y, circleRadius(x, y, w, h), w, h);
    // fill: forwards — иначе между концом анимации и снятием снимка мелькает исходный кадр
    anim = root.animate({ clipPath: grow ? [from, to] : [to, from] },
      { duration: CIRCLE_MS, easing: 'cubic-bezier(.4,0,.2,1)', pseudoElement: pseudo, fill: 'forwards' });
  }).catch(() => {});
  t.finished.catch(() => {}).then(() => {
    clearTimeout(stuck);
    anim?.cancel();
    if (circle === t) circle = null;
    if (!circle) root.classList.remove('rl-theme-vt', 'rl-theme-shrink');
    end();
    paletteChanged();
  });
}

/** Что ставит тема на <html>: палитры обеих сторон и атрибуты (prefs.applyTheme). */
export interface ThemeState {
  light: Record<string, string>; dark: Record<string, string>;
  theme: Theme | null;      // data-theme; null — по системе
  base: string;             // data-base: классическая, день, ночь, тёмная
  outFilled: boolean;       // data-out-filled: свои пузыри залиты цветом
  contrast: boolean;        // html.rl-contrast
  bar: { light: string; dark: string };   // цвет строки браузера (meta theme-color)
}

let shown: ThemeState | null = null;
const THEME_CSS_KEY = 'relay.themeCss', BOOT_KEY = 'relay.themeBoot';

/** Стиль темы: один <style id="rl-theme"> в <head> (его же ставит boot.js до первой отрисовки). */
function themeStyle(): HTMLStyleElement {
  let el = document.getElementById('rl-theme') as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = 'rl-theme'; document.head.appendChild(el); }
  document.getElementById('rl-accent')?.remove();   // стиль акцента прежних версий
  return el;
}

function put(root: HTMLElement, s: ThemeState, css: string): void {
  const el = themeStyle();
  if (el.textContent !== css) el.textContent = css;
  setAttr(root, s.theme);
  root.setAttribute('data-base', s.base);
  root.toggleAttribute('data-out-filled', s.outFilled);
  root.classList.toggle('rl-contrast', s.contrast);
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    m.content = /dark/.test(m.media) ? s.bar.dark : /light/.test(m.media) ? s.bar.light : (s.theme === 'dark' ? s.bar.dark : s.bar.light);
  }
}

/**
 * Ставит тему. animate=false (первое применение) — сразу. Иначе: сменилась сторона (светлая ↔ тёмная) — круг из
 * точки нажатия; та же сторона (Ночь ↔ Тёмная, другой набор, контрастность) — цвета смешиваются по кадрам.
 * CSS и атрибуты запоминаются для boot.js: следующий запуск сразу в этой теме, без вспышки.
 */
export function switchPalette(root: HTMLElement, s: ThemeState, animate: boolean): void {
  const css = paletteCss(s.light, s.dark);
  try {
    if (css) localStorage.setItem(THEME_CSS_KEY, css); else localStorage.removeItem(THEME_CSS_KEY);
    localStorage.setItem(BOOT_KEY, JSON.stringify({ base: s.base, outFilled: s.outFilled, contrast: s.contrast }));
    localStorage.removeItem('relay.accentCss');
  } catch { /* приватный режим */ }
  const from = themeNow(root), prev = shown;
  shown = s;
  const toDark = s.theme ? s.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const to: Theme = toDark ? 'dark' : 'light';
  const swap = () => put(root, s, css);
  if (animate && from !== to && canCircle()) { circleSwitch(root, swap, toDark); return; }
  const before = prev ? prev[from] : {};
  blend(root, palette(from, before), palette(to, s[to]), swap, animate);
}
