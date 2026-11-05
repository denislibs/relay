import { useRef } from 'preact/hooks';
import { useGlobal } from '../../global';
import { setPrefs } from '../../prefs';
import { useCatalog, type CatalogTheme } from '../../themes/catalog';
import { computePalette, tokenValue } from '../../themes/palette';
import { sideOf, type Base, type ThemeSettings } from '../../themes/presets';
import { Swatch } from './Wallpaper';

/**
 * Готовые темы плитками (как в Telegram Web): мини-обои темы, два пузыря её цветами, эмодзи. Первая — «по умолчанию»
 * (🏠: тема базы без готовой). Плитка показывает тему для текущей базы — переключили Ночь/День, плитки перекрасились.
 * onPick — для темы чата; без него выбор ложится в настройки текущей базы.
 */
export function ThemeTiles({ base, selected, onPick }: { base: Base; selected?: string | null; onPick?: (id: string | null) => void }) {
  const themes = useCatalog();
  const choice = useGlobal((s) => s.prefs.themes[base]);
  const current = selected !== undefined ? selected : choice.catalog;
  const strip = useRef<HTMLDivElement>(null);
  const pick = (id: string | null) => {
    if (onPick) { onPick(id); return; }
    setPrefs({ [`themes.${base}.catalog`]: id, ...(id ? { [`themes.${base}.preset`]: null } : {}) });
  };
  // стрелки — по плиткам (группа радиокнопок)
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const items = [...(strip.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowRight' ? 1 : -1)))];
    if (next) { e.preventDefault(); next.focus(); next.click(); }
  };
  return (
    <div class="app-theme-tiles" ref={strip} role="radiogroup" aria-label="Готовые темы" onKeyDown={onKey} data-setting={onPick ? undefined : 'general.themeTiles'}>
      <Tile base={base} title="По умолчанию" emoji="🏠" settings={null} on={!current} onClick={() => pick(null)} />
      {themes.map((t: CatalogTheme) => <Tile key={t.id} base={base} title={t.title} emoji={t.emoji} settings={t.settings[base]} on={current === t.id} onClick={() => pick(t.id)} />)}
    </div>
  );
}

function Tile({ base, title, emoji, settings, on, onClick }: { base: Base; title: string; emoji: string; settings: ThemeSettings | null; on: boolean; onClick: () => void }) {
  const wp = useGlobal((s) => s.prefs.themes[base].wallpaper);
  const side = sideOf(base);
  const p = computePalette(base, settings);
  const v = (name: string) => p[name] ?? tokenValue(name, side) ?? '#888888';
  const colors = [1, 2, 3, 4].map((i) => v('wallpaper-' + i));
  return (
    <button
      type="button" role="radio" aria-checked={on ? 'true' : 'false'} tabIndex={on ? 0 : -1} aria-label={title} title={title}
      class={'app-theme-tile' + (on ? ' app-theme-tile-on' : '')}
      style={{ '--wallpaper-pattern': v('wallpaper-pattern'), '--tile-in': v('bubble-in'), '--tile-out': v('bubble-out'), '--tile-ring': v('brand') }}
      onClick={onClick}
    >
      <Swatch pattern={wp.pattern} colors={colors} dark={side === 'dark'} intensity={wp.intensity} />
      <span class="app-theme-pill app-theme-pill-out" aria-hidden="true" />
      <span class="app-theme-pill app-theme-pill-in" aria-hidden="true" />
      <span class="app-theme-emoji" aria-hidden="true">{emoji}</span>
    </button>
  );
}
