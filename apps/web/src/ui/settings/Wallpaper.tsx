import { CheckRow, InfoRow, PanelHeader, PATTERN_SETS, buildPattern, Section } from '@relay/ui';
import { setPref } from '../../prefs';
import { back } from '../../nav';
import { COLOR_PRESETS, PATTERN_NAMES, sameColors, useWallpaper } from '../../wallpapers';
import { useScrollMemory } from '../useScrollMemory';

const DEFAULT_WP = { pattern: 'catsAndDogs', colors: null, blur: false };

/** Фон превью: четыре цвета как у живых обоев; null — цвета темы. */
export function swatchBackground(colors: string[] | null): string {
  const c = colors ?? [1, 2, 3, 4].map((i) => `var(--wallpaper-${i})`);
  return `linear-gradient(135deg, ${c[0]}, ${c[3]} 45%, ${c[1]} 70%, ${c[2]})`;
}

/** Плитка-превью: градиент + узор поверх (маской, чтобы цвет узора подходил к теме). */
export function Swatch({ pattern, colors, dark, size }: { pattern: string; colors: string[] | null; dark: boolean; size?: number }) {
  return (
    <span class={'app-swatch-fill' + (dark ? ' app-swatch-dark' : '')} style={{ background: swatchBackground(colors), ...(size ? { width: size + 'px', height: size + 'px' } : null) }}>
      <span class="app-swatch-pattern" style={{ '--swatch-pattern': `url(${buildPattern(pattern)})` }} />
    </span>
  );
}

export function Wallpaper() {
  const { dark, key, wp } = useWallpaper();
  const scroll = useScrollMemory('settings/general/wallpaper');
  const presets = COLOR_PRESETS[key];
  const isDefault = wp.pattern === DEFAULT_WP.pattern && wp.colors === null && !wp.blur;
  const choose = (pattern: string, colors: string[] | null) => setPref(`wallpaper.${key}`, { ...wp, pattern, colors });

  return (
    <div class="rl-sidepage" aria-label="Обои">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Обои" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        {Object.keys(PATTERN_SETS).map((set) => (
          <Section key={set} title={PATTERN_NAMES[set] ?? set} role="radiogroup">
            <div class="app-swatches">
              {[{ id: 'theme', name: 'Как в теме', colors: null as string[] | null }, ...presets].map((p) => {
                const on = wp.pattern === set && sameColors(wp.colors, p.colors);
                return (
                  <button
                    key={p.id} type="button" role="radio" aria-checked={on} aria-label={`${PATTERN_NAMES[set] ?? set}: ${p.name}`}
                    class={'app-swatch' + (on ? ' app-swatch-on' : '')} onClick={() => choose(set, p.colors)}
                  >
                    <Swatch pattern={set} colors={p.colors} dark={dark} />
                  </button>
                );
              })}
            </div>
          </Section>
        ))}
        <Section footer="Размытие применяется к обоям чата. Обои для светлой и тёмной темы выбираются отдельно.">
          <CheckRow label="Размытие" checked={wp.blur} onChange={(v: boolean) => setPref(`wallpaper.${key}.blur`, v)} />
          <InfoRow icon="history" title="Сбросить" subtitle="Вернуть обои по умолчанию" onClick={() => { if (!isDefault) setPref(`wallpaper.${key}`, DEFAULT_WP); }} />
        </Section>
      </div>
    </div>
  );
}
