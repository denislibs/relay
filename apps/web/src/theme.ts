import { beginHeavyAnimation } from '@relay/ui';
// Тема: «как в системе» (без data-theme), светлая или тёмная. Выбор хранится в localStorage
// и применяется ещё в index.html до первой отрисовки — без вспышки другой темы.
export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'relay.theme';

export function loadTheme(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}

export function isDark(pref: ThemePref): boolean {
  return pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

/** Плавная смена: на время перехода цвета анимируются (.rl-theme-anim), потом класс снимается. */
export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  const end = beginHeavyAnimation(450); // цвета всей страницы переливаются — тяжёлая анимация
  root.classList.add('rl-theme-anim');
  if (pref === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', pref);
  try { if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch { /* приватный режим */ }
  setTimeout(() => { root.classList.remove('rl-theme-anim'); end(); }, 450);
}
