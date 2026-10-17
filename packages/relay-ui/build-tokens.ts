// tokens.json → tokens.css: светлая тема на :root, тёмная — по системе и по data-theme.
import { join } from 'node:path';

const t = await Bun.file(join(import.meta.dir, 'tokens.json')).json();
const pick = (v: unknown, theme: string) => (typeof v === 'string' ? v : (v as Record<string, string>)[theme] ?? (v as Record<string, string>).light);
const themed = (theme: string) =>
  [...t.color.tokens, ...t.shadow.tokens].map((x: { name: string; value: unknown }) => `  --${x.name}: ${pick(x.value, theme)};`).join('\n');
const fixed = [
  ...['spacing', 'radius', 'duration', 'easing', 'size', 'scale'].flatMap((f) => (t[f]?.tokens ?? []).map((x: { name: string; value: string }) => `  --${x.name}: ${x.value};`)),
  ...Object.entries(t.type.families as Record<string, string>).map(([k, v]) => `  --font-${k}: ${v};`),
  // подложки цветов собеседников — из самого цвета, поэтому темы переключают их вместе с ним
  ...[0, 1, 2, 3, 4, 5, 6].flatMap((i) => [
    `  --peer-${i}-bg: color-mix(in srgb, var(--peer-${i}) 10%, transparent);`,
    `  --peer-${i}-bg-active: color-mix(in srgb, var(--peer-${i}) 17%, transparent);`,
  ]),
  // заливка аватара без фото: насыщенный (светлый) вариант в обеих темах — на нём белые инициалы
  ...t.color.tokens.filter((x: { name: string }) => /^peer-\d$/.test(x.name))
    .map((x: { name: string; value: Record<string, string> }) => `  --${x.name}-fill: ${x.value.light};`),
  // прежние цвета авторов (1–4) — псевдонимы палитры, для иллюстраций и иконок файлов
  ...[5, 1, 2, 3].map((p, i) => `  --author-${i + 1}: var(--peer-${p});`),
].join('\n');

const css = `/* generated from tokens.json — do not edit */
:root {
${themed('light')}
${fixed}
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${themed('dark')}
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
${themed('dark')}
  color-scheme: dark;
}
`;
// пишем только при изменении: сборщик клиента следит за этой папкой, лишняя запись = бесконечная пересборка
const out = join(import.meta.dir, 'tokens.css');
const file = Bun.file(out);
if (!(await file.exists()) || (await file.text()) !== css) await Bun.write(out, css);
console.log('tokens.css written');
