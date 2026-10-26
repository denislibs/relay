// Каталог анимированных эмодзи (как в Telegram): один эмодзи в сообщении — анимированный стикер из набора
// AnimatedEmojies, по клику — эффект из EmojiAnimations. Грузится один раз за сессию при первом таком сообщении;
// до ответа сообщение показывается крупным текстом (переключение на стикер — только после ответа).
import type { AnimatedEmojiCatalog, DiceFace } from '@relay/protocol';
import { useEffect, useState } from 'preact/hooks';

let cat: AnimatedEmojiCatalog | null = null;
let version = 0;
let started = false;
let failed = false;   // каталог не пришёл — кубики рисуются своей графикой, а не ждут
const listeners = new Set<() => void>();

export function loadAnimatedEmoji(): void {
  if (started) return;
  started = true;
  fetch('/animated-emoji', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() as Promise<AnimatedEmojiCatalog> : Promise.reject(new Error(String(r.status)))))
    .then((j) => { cat = j; failed = false; version++; for (const fn of listeners) fn(); }, () => { started = false; failed = true; version++; for (const fn of listeners) fn(); });
}

/** Адрес анимации эмодзи (ключ без FE0F), нет — undefined: сообщение остаётся крупным текстом. */
export const animatedEmojiUrl = (key: string): string | undefined => cat?.emoji[key];
/** Эффекты по клику: варианты для этого эмодзи (пусто — берут общие). */
export const emojiEffects = (key: string): string[] => cat?.effects[key] ?? [];
/** Общие эффекты (💥) — когда у эмодзи своих нет. */
export const genericEmojiEffects = (): string[] => cat?.generic ?? [];
export const animatedEmojiLoaded = (): boolean => !!cat;
/** Грани броска из набора Telegram: null — анимации нет (свой рисунок), undefined — каталог ещё в пути. */
export const diceFaces = (emoji: string): DiceFace[] | null | undefined => (emoji === '🎰' ? null : cat ? cat.dice?.[emoji] ?? null : failed ? null : undefined);

/** Версия каталога — строки ленты перерисовываются, когда он пришёл. Вызов — только там, где такие сообщения есть. */
export function useAnimatedEmoji(need: boolean): number {
  const [v, setV] = useState(version);
  useEffect(() => {
    if (!need) return;
    loadAnimatedEmoji();
    const fn = () => setV(version);
    listeners.add(fn);
    if (v !== version) fn();
    return () => { listeners.delete(fn); };
  }, [need]);
  return v;
}
