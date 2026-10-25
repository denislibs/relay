// Выбор медиа в сетке «Медиа» (правая панель и глобальный поиск), как в Telegram Web K: «Выбрать» в меню плитки —
// режим выбора с кружками на плитках, вместо вкладок — пилюля «✕ N сообщений ⟶». Чистые расчёты; UI — ui/mediaMenu.tsx.

/** Ключ плитки: в глобальном поиске id сообщений разных чатов могут совпасть — поэтому чат и id. */
export const mediaKey = (chatId: number, id: number): string => chatId + ':' + id;

/** Отметить или снять плитку; порядок — порядок выбора (как в Telegram). */
export function toggleKey(sel: readonly string[], key: string): string[] {
  return sel.includes(key) ? sel.filter((k) => k !== key) : [...sel, key];
}

/** Выбранное по чатам-источникам: пересылка идёт отдельным вызовом на чат (forward.ts startForwardMany).
 *  Порядок чатов — по первому выбранному из чата; сообщения внутри чата упорядочит startForward. */
export function groupByChat<T>(keys: readonly string[], find: (key: string) => T | undefined): { chatId: number; items: T[] }[] {
  const out = new Map<number, T[]>();
  for (const k of keys) {
    const m = find(k);
    if (!m) continue;
    const chatId = Number(k.slice(0, k.indexOf(':')));
    let list = out.get(chatId);
    if (!list) out.set(chatId, (list = []));
    list.push(m);
  }
  return [...out].map(([chatId, items]) => ({ chatId, items }));
}

/** «1 сообщение», «3 сообщения», «5 сообщений». */
export function messagesLabel(n: number): string {
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? 'сообщение' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'сообщения' : 'сообщений'}`;
}

/** Долгое нажатие пальцем: столько держать, и палец не дальше SLOP px от места касания (иначе это прокрутка). */
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP = 10;
export const movedTooFar = (x0: number, y0: number, x: number, y: number): boolean => Math.hypot(x - x0, y - y0) > LONG_PRESS_SLOP;
