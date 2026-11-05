// Готовые темы (плитки): каталог с сервера (GET /themes), кэш — в localStorage, чтобы выбранная тема применялась
// с первого кадра и без сети. prefs берёт у каталога цвета темы для базы (setCatalogLookup).
import { useEffect, useState } from 'preact/hooks';
import { setCatalogLookup } from '../prefs';
import type { Base, ThemeSettings } from './presets';

export interface CatalogTheme { id: string; emoji: string; title: string; settings: Record<Base, ThemeSettings> }

const KEY = 'relay.themes';
const valid = (t: unknown): t is CatalogTheme => {
  const x = t as CatalogTheme;
  return !!x && typeof x.id === 'string' && /^[a-z0-9-]{1,32}$/.test(x.id) && typeof x.emoji === 'string' && typeof x.title === 'string'
    && !!x.settings && (['classic', 'day', 'night', 'tinted'] as const).every((b) => typeof x.settings[b]?.accent === 'string' && /^#[0-9a-f]{6}$/i.test(x.settings[b].accent));
};

let themes: CatalogTheme[] = (() => {
  try { const j = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(j) ? j.filter(valid) : []; } catch { return []; }
})();
const listeners = new Set<() => void>();

export const catalog = (): CatalogTheme[] => themes;
export const catalogTheme = (id: string | null | undefined): CatalogTheme | undefined => (id ? themes.find((t) => t.id === id) : undefined);

setCatalogLookup((id, base) => catalogTheme(id)?.settings[base] ?? null);

let loading: Promise<void> | null = null;
/** Каталог с сервера; один запрос за запуск. Без сети или без входа — остаётся кэш. */
export function loadCatalog(): Promise<void> {
  return loading ??= (async () => {
    try {
      const r = await fetch('/themes', { credentials: 'include' });
      if (!r.ok) { loading = null; return; }
      const j = (await r.json()) as { themes?: unknown[] };
      const next = (j.themes ?? []).filter(valid);
      if (JSON.stringify(next) === JSON.stringify(themes)) return;
      themes = next;
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* приватный режим */ }
      setCatalogLookup((id, base) => catalogTheme(id)?.settings[base] ?? null);   // перечитать палитру с новыми цветами
      for (const fn of listeners) fn();
    } catch { loading = null; }
  })();
}

/** Каталог для интерфейса: перерисуется, когда придёт с сервера. */
export function useCatalog(): CatalogTheme[] {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    listeners.add(fn);
    void loadCatalog();
    return () => { listeners.delete(fn); };
  }, []);
  return themes;
}
