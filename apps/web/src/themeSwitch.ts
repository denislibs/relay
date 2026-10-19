import { beginHeavyAnimation, reducedMotion, requestMutation } from '@relay/ui';
import tokens from '@relay/ui/tokens.json';
import { accentCss, accentTokens } from './accent';
// Смена темы и акцента кадр за кадром: цвета токенов смешиваются на <html> от старых значений
// к новым (≈200 мс). Остальные transition на это время выключены (.rl-theme-switching):
// иначе каждый элемент переливался бы по-своему.

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

/** Цвета всех токенов темы с учётом акцента — то, что сейчас на экране. */
function palette(theme: Theme, accent: string): Map<string, Rgba> {
  const over = accentTokens(accent, theme);
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
const setAttr = (root: HTMLElement, pref: string) => { if (pref === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', pref); };
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

function blend(root: HTMLElement, from: Map<string, Rgba>, to: Map<string, Rgba>, swap: () => void, animate: boolean): void {
  const run = ++running;
  const names = [...to.keys()].filter((n) => { const a = from.get(n), b = to.get(n)!; return a && a.some((x, i) => x !== b[i]); });
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

let accentNow = 'green';

/**
 * Ставит тему на <html>. animate=false (первое применение) — сразу. Иначе, если светлость меняется
 * и движение не урезано (reducedMotion учитывает data-anim="0"), — смешивание по кадрам.
 */
export function switchTheme(root: HTMLElement, pref: 'system' | 'light' | 'dark', toDark: boolean, animate: boolean): void {
  const from = themeNow(root), to: Theme = toDark ? 'dark' : 'light';
  blend(root, palette(from, accentNow), palette(to, accentNow), () => setAttr(root, pref), animate && from !== to);
}

const ACCENT_CSS_KEY = 'relay.accentCss';

/** Стиль акцента: один <style id="rl-accent"> в <head> (его же ставит index.html до первой отрисовки). */
function accentStyle(): HTMLStyleElement {
  let el = document.getElementById('rl-accent') as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = 'rl-accent'; document.head.appendChild(el); }
  return el;
}

/** Меняет акцент; CSS запоминается для index.html, чтобы следующий запуск сразу был нужного цвета. */
export function switchAccent(root: HTMLElement, id: string, animate: boolean): void {
  const theme = themeNow(root);
  const from = palette(theme, accentNow);
  accentNow = id;
  const css = accentCss(id);
  try { if (css) localStorage.setItem(ACCENT_CSS_KEY, css); else localStorage.removeItem(ACCENT_CSS_KEY); } catch { /* приватный режим */ }
  blend(root, from, palette(theme, id), () => { const el = accentStyle(); if (el.textContent !== css) el.textContent = css; }, animate);
}
