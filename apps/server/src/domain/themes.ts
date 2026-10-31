// Каталог готовых тем (плитки в «Общих настройках» и тема чата). Свои: эмодзи — системные, цвета и обои — наши.
// Тема задаёт для каждой базы клиента (classic/day/night/tinted) акцент, цвет своего пузыря и 4 цвета обоев;
// клиент считает из этого палитру (apps/web/src/themes). Сервер хранит у чата только id темы и проверяет его здесь.

export interface ThemeSettings { accent: string; bubble?: string[]; wallpaper?: { colors: string[] } }
export interface CatalogTheme { id: string; emoji: string; title: string; settings: Record<'classic' | 'day' | 'night' | 'tinted', ThemeSettings> }

type Seed = { id: string; emoji: string; title: string; accent: string; pale: string; deep: string; light: string[]; dark: string[] };

// pale — свой пузырь в Классической, deep — в Ночи; в Дне пузырь залит акцентом, в Тёмной — из акцента (клиент)
const SEEDS: Seed[] = [
  { id: 'chick', emoji: '🐥', title: 'Цыплёнок', accent: '#e8a400', pale: '#fff3c4', deep: '#6b5212', light: ['#f7e7a1', '#f4d06f', '#fbefc4', '#e9c46a'], dark: ['#2f2a12', '#3d3311', '#22200d', '#36301a'] },
  { id: 'snow', emoji: '⛄', title: 'Снеговик', accent: '#3a9be0', pale: '#dff1ff', deep: '#1f4f78', light: ['#d6ecfb', '#b7dbf5', '#e9f5fd', '#a7cdee'], dark: ['#15263a', '#1b3150', '#101c2b', '#1e3a5c'] },
  { id: 'gem', emoji: '💎', title: 'Самоцвет', accent: '#8a6cf0', pale: '#ece5ff', deep: '#43307d', light: ['#e1d8fb', '#c9b8f4', '#efeafd', '#b7a2ee'], dark: ['#231a3d', '#2e2150', '#19132c', '#33275c'] },
  { id: 'sakura', emoji: '🌸', title: 'Сакура', accent: '#e05c93', pale: '#ffe3ee', deep: '#7a2d4c', light: ['#fbdbe7', '#f6c1d6', '#fdeaf1', '#efaac6'], dark: ['#33172a', '#421c36', '#24101e', '#4a2040'] },
  { id: 'forest', emoji: '🌲', title: 'Лес', accent: '#2f9e57', pale: '#e0f6e4', deep: '#1f5a36', light: ['#d5ecd4', '#b6dcb6', '#e6f4e3', '#a3d0a6'], dark: ['#14281c', '#1a3424', '#0e1d14', '#1f3d2b'] },
  { id: 'orange', emoji: '🍊', title: 'Апельсин', accent: '#ef7d1a', pale: '#ffe9d4', deep: '#7a3f14', light: ['#fbe0c6', '#f6c79d', '#fdeedd', '#f0b27c'], dark: ['#33200f', '#43290f', '#24170b', '#4a2e14'] },
  { id: 'ocean', emoji: '🌊', title: 'Океан', accent: '#109fb4', pale: '#d9f5f8', deep: '#16525c', light: ['#cdeef2', '#a8dfe7', '#e3f7f9', '#8fd2dd'], dark: ['#0f2a30', '#12353d', '#0a1e23', '#163f48'] },
  { id: 'coffee', emoji: '☕', title: 'Кофе', accent: '#a0673c', pale: '#f3e6da', deep: '#5a3a22', light: ['#ecdcc9', '#dcc1a3', '#f4eadf', '#cfae8a'], dark: ['#2a1f17', '#35271c', '#1e1611', '#3d2d21'] },
];

export const THEMES: CatalogTheme[] = SEEDS.map((s) => ({
  id: s.id, emoji: s.emoji, title: s.title,
  settings: {
    classic: { accent: s.accent, bubble: [s.pale], wallpaper: { colors: s.light } },
    day: { accent: s.accent, bubble: [s.accent], wallpaper: { colors: s.light } },
    night: { accent: s.accent, bubble: [s.deep], wallpaper: { colors: s.dark } },
    tinted: { accent: s.accent, wallpaper: { colors: s.dark } },
  },
}));

export const themeById = (id: string): CatalogTheme | undefined => THEMES.find((t) => t.id === id);
