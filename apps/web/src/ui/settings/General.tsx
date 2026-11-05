import { Bubble, CheckRow, InfoRow, PanelHeader, RadioRow, RangeRow, Section } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import { back, go } from '../../nav';
import { setPref, setPrefs, type ThemePref } from '../../prefs';
import { BASE_ACCENT, PRESETS, type Base, type Preset } from '../../themes/presets';
import { useBase, useWallpaper } from '../../wallpapers';
import { ThemeTiles } from './ThemeTiles';
import { useWallpaperImage } from '../../wallpaperImage';
import { hm, localeTimeFormat } from '../format';
import { useScrollMemory } from '../useScrollMemory';
import { Swatch, swatchBackground } from './Wallpaper';

/** Порядок и названия — как в Telegram Web: Classic, Night, Day, Dark, System Default. */
export const THEME_TITLES: Record<ThemePref, string> = { classic: 'Классическая', night: 'Ночь', day: 'День', tinted: 'Тёмная', system: 'Как в системе' };
const THEMES: ThemePref[] = ['classic', 'night', 'day', 'tinted', 'system'];

/** Кружок набора: цвет пузыря (два — диагональным градиентом, как кружки акцентов у Telegram) или акцент. */
const swatchOf = (p: Preset): string => {
  const b = p.settings.bubble;
  return b && b.length > 1 ? `linear-gradient(135deg, ${b[0]}, ${b[1]})` : (b?.[0] && b[0].toLowerCase() !== '#ffffff' && p.settings.accent === b[0] ? b[0] : p.settings.accent);
};

/** Ряд наборов текущей темы: «как в теме» и наборы базы. Выбор сбрасывает готовую тему (плитку). */
function Accents({ base }: { base: Base }) {
  const choice = useGlobal((s) => s.prefs.themes[base]);
  const pick = (preset: string | null) => setPrefs({ [`themes.${base}.preset`]: preset, [`themes.${base}.catalog`]: null });
  const items: { id: string | null; name: string; bg: string }[] = [
    { id: null, name: 'Как в теме', bg: BASE_ACCENT[base] },
    ...PRESETS[base].map((p, i) => ({ id: p.id, name: 'Набор ' + (i + 1), bg: swatchOf(p) })),
  ];
  return (
    <div class="app-accents" role="radiogroup" aria-label="Цвет">
      {items.map((a) => {
        const on = !choice.catalog && choice.preset === a.id;
        return (
          <button
            key={a.id ?? 'default'} type="button" role="radio" class="app-accent" aria-checked={on ? 'true' : 'false'}
            aria-label={a.name} title={a.name} style={{ '--swatch': a.bg.startsWith('linear') ? 'var(--brand)' : a.bg, background: a.bg }}
            onClick={() => pick(a.id)}
          />
        );
      })}
    </div>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Текущее время, обновляется на границе минуты. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => { setNow(new Date()); t = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50); };
    t = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(t);
  }, []);
  return now;
}

export function General() {
  const prefs = useGlobal((s) => s.prefs);
  const base = useBase();
  const { dark, wp, key } = useWallpaper();
  const wpImage = useWallpaperImage(key, wp.image);
  const scroll = useScrollMemory('settings/general');
  const now = useNow();
  const fmt = prefs.timeFormat ?? localeTimeFormat();

  return (
    <div class="rl-sidepage" aria-label="Общие настройки">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Общие настройки" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section title="Настройки">
          <div class="app-textpreview" style={wpImage ? { background: `center / cover no-repeat url("${wpImage}")` } : { background: swatchBackground(wp.colors, dark) }} aria-hidden="true">
            <Bubble from="in" tail time={hm(now)}>Привет! Так выглядит ваш текст.</Bubble>
            <Bubble from="out" tail time={hm(now)} status="read">Отлично, размер подходит.</Bubble>
          </div>
          <RangeRow setting="general.textSize" label="Размер текста сообщений" min={12} max={20} step={1} value={prefs.textSize} onChange={(v: number) => setPref('textSize', v)} />
          <InfoRow
            icon="image" title="Обои чата" onClick={() => void go('settings/general/wallpaper')}
            trailing={<span class="app-swatch-mini" aria-hidden="true">{wpImage ? <span class="app-swatch-fill app-swatch-photo" style={{ backgroundImage: `url("${wpImage}")` }} /> : <Swatch pattern={wp.pattern} colors={wp.colors} dark={dark} intensity={wp.intensity} />}</span>}
          />
        </Section>
        <Section setting="general.theme" title="Цветовая тема">
          <ThemeTiles base={base} />
          <div role="radiogroup" aria-label="Тема">
            {THEMES.map((t) => (
              <RadioRow
                setting={'general.theme.' + t} key={t} label={THEME_TITLES[t]} checked={prefs.theme === t} onClick={() => setPref('theme', t)}
                subtitle={t === 'system' ? `Днём — ${THEME_TITLES[prefs.lastLight].toLowerCase()}, ночью — ${THEME_TITLES[prefs.lastDark].toLowerCase()}` : undefined}
              />
            ))}
          </div>
          <div data-setting="general.accent"><Accents base={base} /></div>
          <CheckRow setting="general.contrast" label="Повышенная контрастность" subtitle="Текст и ссылки ярче на любом фоне" checked={prefs.contrast} onChange={(v: boolean) => setPref('contrast', v)} />
        </Section>
        <Section setting="general.timeFormat" title="Формат времени" role="radiogroup">
          <RadioRow setting="general.timeFormat.12h" label="12 часов" subtitle={hm(now, '12h')} checked={fmt === '12h'} onClick={() => setPref('timeFormat', '12h')} />
          <RadioRow setting="general.timeFormat.24h" label="24 часа" subtitle={hm(now, '24h')} checked={fmt === '24h'} onClick={() => setPref('timeFormat', '24h')} />
        </Section>
        <Section setting="general.sendKey" title="Клавиатура" role="radiogroup">
          <RadioRow setting="general.sendKey.enter" label="Enter — отправить, Shift+Enter — новая строка" checked={prefs.sendKey === 'enter'} onClick={() => setPref('sendKey', 'enter')} />
          <RadioRow setting="general.sendKey.ctrlEnter"
            label={isMac ? '⌘+Enter — отправить' : 'Ctrl+Enter — отправить'} subtitle="Enter — новая строка"
            checked={prefs.sendKey === 'ctrlEnter'} onClick={() => setPref('sendKey', 'ctrlEnter')}
          />
        </Section>
        <Section>
          <InfoRow icon="keyboard" title="Сочетания клавиш" onClick={() => void go('settings/general/shortcuts')} />
        </Section>
      </div>
    </div>
  );
}
