// Эмодзи для панели: категории Unicode (как в Telegram), оттенки кожи, поиск. Иконка — для полосы категорий.
import { EMOJI_LISTS, EMOJI_NAMES, EMOJI_TONES } from './emojiTable';

export interface EmojiCategory { id: string; title: string; icon: string; list: string[] }

const split = (s: string) => [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(s.replace(/\s+/g, ''))].map((x) => x.segment);

const CAT_META: [id: string, title: string, icon: string][] = [
  ['people', 'Смайлики и люди', 'smile'], ['nature', 'Животные и природа', 'leaf'], ['food', 'Еда и напитки', 'coffee'],
  ['activity', 'Занятия', 'gamepad'], ['travel', 'Путешествия', 'plane'], ['objects', 'Предметы', 'bulb'],
  ['symbols', 'Символы', 'heart'], ['flags', 'Флаги', 'flag'],
];
/** Все эмодзи Unicode, у которых есть картинка (emojiTable.ts — из emoji-datasource, порядок Unicode). */
export const EMOJI: EmojiCategory[] = CAT_META.map(([id, title, icon]) => ({ id, title, icon, list: EMOJI_LISTS[id] ?? [] }));

/** Пять оттенков кожи эмодзи (светлый → тёмный); нет — у эмодзи нет оттенков. */
export const emojiTones = (e: string): string[] | undefined => EMOJI_TONES[e];
const TONE_KEY = 'relay.emoji.tones';
/** Выбранные оттенки: базовый эмодзи → номер оттенка 0…4 (как в Telegram — запоминается для каждого эмодзи). */
export function savedTones(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(TONE_KEY) ?? '{}') as Record<string, number>; } catch { return {}; }
}
/** tone — номер оттенка или null (без оттенка, жёлтый). */
export function saveTone(base: string, tone: number | null): void {
  const all = savedTones();
  if (tone == null) delete all[base]; else all[base] = tone;
  try { localStorage.setItem(TONE_KEY, JSON.stringify(all)); } catch { /* приватный режим */ }
}

const RECENT_KEY = 'relay.emoji.recent';
export function recentEmoji(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { return []; }
}
export function pushRecentEmoji(e: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recentEmoji().filter((x) => x !== e)].slice(0, 32))); } catch { /* приватный режим */ }
}

/** Быстрые фильтры в строке поиска (контурные значки, как в Telegram): для стикеров — эмодзи, для эмодзи — группа. */
export const QUICK: { icon: string; label: string; emoji: string; group: string[] }[] = [
  { icon: 'heart', label: 'Любовь', emoji: '❤️', group: split('❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝😍🥰😘😻💋🌹') },
  { icon: 'like', label: 'Одобрение', emoji: '👍', group: split('👍👌🤙💪🙌👏✌️🤝🙏✅💯🔥⭐🆗🫡') },
  { icon: 'dislike', label: 'Неодобрение', emoji: '👎', group: split('👎😒🙄😤😠😡🤬💩❌🚫😑🤦🤷') },
  { icon: 'party', label: 'Праздник', emoji: '🎉', group: split('🎉🥳🎊🎈🎂🍾🥂🎁✨🎆🎇🪅🍰🍻') },
  { icon: 'smile', label: 'Радость', emoji: '😀', group: split('😀😃😄😁😆😅🤣😂🙂😊😉😇🤗😋😎🤩') },
  { icon: 'sad', label: 'Грусть', emoji: '😢', group: split('😢😭😞😔😟🙁☹️😿💔😥😪😓🥺😩') },
];

/** Поиск эмодзи по словам (имён в Unicode нет в браузере — небольшой словарь частых слов). */
const WORDS: [string, string][] = [
  ['сердце любовь люблю', '❤️🧡💛💚💙💜🖤🤍💕💖💘😍🥰😘'], ['смех смешно ржу', '😂🤣😆😹'], ['улыбка радость', '😀😃😄😁😊🙂'],
  ['грусть плачу слёзы слезы', '😢😭😞😔🥺'], ['злость злой бесит', '😠😡🤬😤'], ['огонь круто', '🔥💯⚡'], ['лайк класс ок', '👍👌👏🙌'],
  ['праздник поздравляю день рождения', '🎉🥳🎂🎁🎊🍾'], ['кот кошка', '🐱🐈😺😸😹😻'], ['собака пёс пес', '🐶🐕🦮🐩'],
  ['еда есть', '🍕🍔🍟🍣🍜🥗'], ['кофе чай', '☕🍵🧋'], ['сон спать устал', '😴💤🛌🥱'], ['деньги', '💰💵💸🤑'],
  ['цветы цветок', '🌸🌷🌹🌺🌻💐'], ['солнце жара', '☀️🌞🔥🥵'], ['звезда', '⭐🌟✨💫'], ['машина авто', '🚗🚕🚙🏎️'],
  ['самолёт самолет', '✈️🛫🛬'], ['думаю хм', '🤔🧐'], ['спасибо пожалуйста', '🙏🤝'], ['привет пока', '👋🤗'], ['шок ого', '😱😮😲🤯'],
];
export function searchEmoji(q: string): string[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const out = new Set<string>();
  for (const [words, list] of WORDS) if (words.split(' ').some((w) => w.startsWith(t) || t.startsWith(w))) for (const e of split(list)) out.add(e);
  // английские имена Unicode (emoji-datasource): «cat», «heart», «thumbs up» — по началу любого слова
  if (/^[a-z0-9 ]+$/.test(t)) for (const e in EMOJI_NAMES) if ((' ' + EMOJI_NAMES[e]).includes(' ' + t)) out.add(e);
  return [...out];
}
