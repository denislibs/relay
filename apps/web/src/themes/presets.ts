// Базовые темы и наборы акцентов. Набор = акцент + (необязательно) цвет своего пузыря + (необязательно) обои.
// Числа — пресеты iOS-клиента Telegram (ThemeColorPresets / DefaultDarkTintedPresentationTheme), взятые как данные;
// индексы сохранены, чтобы набор узнавался. Цвета наших акцентов — из accent.ts.
import { ACCENTS } from '../accent';
import { fromInt } from './color';

export type Base = 'classic' | 'day' | 'night' | 'tinted';
export const BASES: Base[] = ['classic', 'night', 'day', 'tinted'];
export type Side = 'light' | 'dark';
export const sideOf = (b: Base): Side => (b === 'night' || b === 'tinted' ? 'dark' : 'light');

/** Что задаёт тема для одной базы (набор, готовая тема, тема чата). */
export interface ThemeSettings {
  accent: string;                      // #rrggbb
  bubble?: string[];                   // 1–2 цвета своего пузыря; несколько — усредняются (как в tweb)
  wallpaper?: { colors: string[] };    // 4 цвета градиента обоев (узор и яркость — из настроек обоев)
}

export interface Preset { id: string; settings: ThemeSettings }

/** Акцент базы «как в теме» — без набора. Классическая и Ночь — зелёный кита; День — синий, Тёмная — синий iOS. */
export const BASE_ACCENT: Record<Base, string> = { classic: '#25d366', night: '#25d366', day: '#2d7ed5', tinted: '#3685fa' };

type Raw = { id: number; accent: number; bubble?: number[]; wp?: number[] };
const toPreset = (prefix: string) => (r: Raw): Preset => ({
  id: prefix + r.id,
  settings: {
    accent: fromInt(r.accent),
    ...(r.bubble ? { bubble: r.bubble.map(fromInt) } : {}),
    // у одного пресета три цвета — четвёртым повторяем последний (наши обои — ровно 4 цвета)
    ...(r.wp ? { wallpaper: { colors: [...r.wp, ...Array(4 - r.wp.length).fill(r.wp[r.wp.length - 1])].map(fromInt) } } : {}),
  },
});

// Классическая (iOS dayClassic, 101–107): бледный пузырь и обои с узором
const CLASSIC: Raw[] = [
  { id: 106, accent: 0xf55783, bubble: [0xd6f5ff, 0xc9fdfe], wp: [0x8dc0eb, 0xb9d1ea, 0xc6b1ef, 0xebd7ef] },
  { id: 102, accent: 0xff5fa9, bubble: [0xfff4d7], wp: [0xeaa36e, 0xf0e486, 0xf29ebf, 0xe8c06e] },
  { id: 104, accent: 0x5a9e29, bubble: [0xfff8df], wp: [0x7fc289, 0xe4d573, 0xafd677, 0xf0c07a] },
  { id: 101, accent: 0x7e5fe5, bubble: [0xf5e2ff], wp: [0xe4b2ea, 0x8376c2, 0xeab9d9, 0xb493e6] },
  { id: 107, accent: 0x2cb9ed, bubble: [0xadf7b5, 0xfcff8b], wp: [0x1a2e1a, 0x47623c, 0x222e24, 0x314429] },
  { id: 103, accent: 0x199972, bubble: [0xfffec7], wp: [0xdceb92, 0x8fe1d6, 0x67a3f2, 0x85d685] },
  { id: 105, accent: 0xda90d9, bubble: [0x94fff9, 0xccffc7], wp: [0xffc3b2, 0xe2c0ff, 0xffe7b2] },
];
// День (iOS day, 101–104): пузырь залит, обоев набор не меняет
const DAY: Raw[] = [
  { id: 101, accent: 0x0088ff, bubble: [0x0088ff, 0xff53f4] },
  { id: 102, accent: 0x00b09b, bubble: [0xaee946, 0x00b09b] },
  { id: 103, accent: 0xd33213, bubble: [0xf9db00, 0xd33213] },
  { id: 104, accent: 0xea8ced, bubble: [0xea8ced, 0x00c2ed] },
];
// Ночь (iOS night, 102–104): тёмные обои
const NIGHT: Raw[] = [
  { id: 102, accent: 0x00b09b, bubble: [0xaee946, 0x00b09b], wp: [0xe4b2ea, 0x8376c2, 0xeab9d9, 0xb493e6] },
  { id: 103, accent: 0xd33213, bubble: [0xf9db00, 0xd33213], wp: [0xfec496, 0xdd6cb9, 0x962fbf, 0x4f5bd5] },
  { id: 104, accent: 0xea8ced, bubble: [0xea8ced, 0x00c2ed], wp: [0x8adbf2, 0x888dec, 0xe39fea, 0x679ced] },
];

/** Базовые цвета iOS: в «Тёмной» у каждого — свой тёмный градиент обоев (того же оттенка, приглушённый). */
export const BASE_COLORS: { name: string; color: string; wallpaper: string[] }[] = [
  { name: 'blue', color: '#0088ff', wallpaper: ['#1e3557', '#182036', '#1c4352', '#16263a'] },
  { name: 'cyan', color: '#00c2ed', wallpaper: ['#1e3557', '#151a36', '#1c4352', '#2a4541'] },
  { name: 'green', color: '#29b327', wallpaper: ['#2d4836', '#172b19', '#364331', '#103231'] },
  { name: 'pink', color: '#eb6ca4', wallpaper: ['#2c0b22', '#290020', '#160a22', '#3b1834'] },
  { name: 'orange', color: '#f08200', wallpaper: ['#2c211b', '#442917', '#22191f', '#3b2714'] },
  { name: 'purple', color: '#9472ee', wallpaper: ['#3a1c3a', '#24193c', '#392e3e', '#1a1632'] },
  { name: 'red', color: '#d33213', wallpaper: ['#2c211b', '#44332a', '#22191f', '#3b2d36'] },
  { name: 'yellow', color: '#edb400', wallpaper: ['#2c2512', '#45360b', '#221d08', '#3b2f13'] },
  { name: 'gray', color: '#6d839e', wallpaper: ['#1c2731', '#1a1c25', '#27303b', '#1b1b21'] },
];

/** Ближайший базовый цвет к акценту (по RGB): чей тёмный градиент обоев взять «Тёмной» с этим акцентом. */
export function nearestBaseColor(accent: string): (typeof BASE_COLORS)[number] {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const a = p(accent);
  let best = BASE_COLORS[0], dist = Infinity;
  for (const b of BASE_COLORS) {
    const c = p(b.color), d = (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2 + (c[2] - a[2]) ** 2;
    if (d < dist) { dist = d; best = b; }
  }
  return best;
}

// наши акценты (кроме зелёного — он и есть «как в теме») — простые наборы без пузыря и обоев
const PLAIN: Preset[] = ACCENTS.slice(1).map((a) => ({ id: 'a-' + a.id, settings: { accent: a.color } }));

/** Ряд кружков базы: «как в теме» (null) не входит — интерфейс рисует его первым. */
export const PRESETS: Record<Base, Preset[]> = {
  classic: [...CLASSIC.map(toPreset('c')), ...PLAIN],
  day: [...DAY.map(toPreset('d')), ...PLAIN],
  night: [...NIGHT.map(toPreset('n')), ...PLAIN],
  tinted: BASE_COLORS.map((b) => ({ id: 't-' + b.name, settings: { accent: b.color, wallpaper: { colors: b.wallpaper } } })),
};

export const presetById = (base: Base, id: string | null | undefined): Preset | undefined =>
  id ? PRESETS[base].find((p) => p.id === id) : undefined;
