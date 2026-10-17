import { beginHeavyAnimation, reducedMotion, requestMutation } from '@relay/ui';
import tokens from '@relay/ui/tokens.json';
// Смена темы кадр за кадром: цвета токенов, у которых светлое и тёмное значения различаются,
// смешиваются на <html> от старой темы к новой (≈200 мс). Остальные transition на это время
// выключены (.rl-theme-switching): иначе каждый элемент переливался бы по-своему.

type Rgba = [number, number, number, number];

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

// Цветовые токены, у которых светлое и тёмное значение различаются: их и смешиваем при смене темы
const PAIRS = (tokens.color.tokens as { name: string; value: string | { light: string; dark: string } }[]).flatMap((t) => {
  if (typeof t.value === 'string' || t.value.light === t.value.dark) return [];
  const light = parseColor(t.value.light), dark = parseColor(t.value.dark);
  return light && dark ? [{ name: '--' + t.name, light, dark }] : [];
});

const DURATION_MS = 200;
const ease = (t: number) => 1 - (1 - t) ** 3.5;   // быстрый старт, мягкая посадка
let running = 0;

const setAttr = (root: HTMLElement, pref: string) => { if (pref === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', pref); };
const clear = (root: HTMLElement) => { for (const p of PAIRS) root.style.removeProperty(p.name); root.classList.remove('rl-theme-switching'); };

/**
 * Ставит тему на <html>. animate=false (первое применение) — сразу. Иначе, если светлость меняется
 * и движение не урезано (reducedMotion учитывает data-anim="0"), — смешивание по кадрам.
 */
export function switchTheme(root: HTMLElement, pref: 'system' | 'light' | 'dark', toDark: boolean, animate: boolean): void {
  const attr = root.getAttribute('data-theme');
  const wasDark = attr ? attr === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const run = ++running;
  if (!animate || wasDark === toDark || reducedMotion() || !PAIRS.length) {
    clear(root);   // прерванное смешивание не оставляет переопределений
    setAttr(root, pref);
    return;
  }

  const end = beginHeavyAnimation(DURATION_MS + 100);   // цвета всей страницы меняются — тяжёлая анимация
  const from = wasDark ? 'dark' : 'light', to = toDark ? 'dark' : 'light';
  const start = performance.now();
  const frame = () => requestMutation(() => {
    if (run !== running) { end(); return; }             // поверх началась новая смена
    const t = Math.min(1, (performance.now() - start) / DURATION_MS);
    if (t >= 1) { clear(root); end(); return; }
    const k = ease(t);
    for (const p of PAIRS) {
      const a = p[from], b = p[to];
      const c = (i: number) => Math.round(a[i] + (b[i] - a[i]) * k);
      root.style.setProperty(p.name, `rgba(${c(0)},${c(1)},${c(2)},${+(a[3] + (b[3] - a[3]) * k).toFixed(3)})`);
    }
    frame();
  });
  requestMutation(() => {
    if (run !== running) { end(); return; }
    root.classList.add('rl-theme-switching');
    for (const p of PAIRS) { const a = p[from]; root.style.setProperty(p.name, `rgba(${a[0]},${a[1]},${a[2]},${a[3]})`); }
    setAttr(root, pref);
    frame();
  });
}
