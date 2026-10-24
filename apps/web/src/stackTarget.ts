// Что лежит в стеке чатов: чат или тред комментариев в нём (docs/navigation-rules.md). Чистые правила без DOM —
// стек в data.ts, тесты в stackTarget.test.ts.

/** Слой стека: чат, а у треда — ещё id копии поста в группе обсуждения (корень треда). */
export interface StackTarget { chatId: number; threadId?: number }

/** Тот же слой: чат и тред совпадают (лента группы и её тред — разные слои). */
export const sameTarget = (a: StackTarget, b: StackTarget): boolean => a.chatId === b.chatId && (a.threadId ?? null) === (b.threadId ?? null);

/** Где этот слой в стеке (снизу вверх), -1 — нет. */
export function findTarget(stack: readonly StackTarget[], t: StackTarget): number {
  return stack.findIndex((f) => sameTarget(f, t));
}

/** Ключ позиции прокрутки: у ленты чата — id, у треда — chatId:threadId (не путаются с лентой группы). */
export const positionKey = (t: StackTarget): string => (t.threadId != null ? t.chatId + ':' + t.threadId : String(t.chatId));

/** Адрес верхнего слоя: #chat=1 или #chat=1&thread=2; ничего не открыто — пусто. */
export function hashFor(t: StackTarget | null | undefined): string {
  if (!t) return '';
  return '#chat=' + t.chatId + (t.threadId != null ? '&thread=' + t.threadId : '');
}

/** Разбор адреса при загрузке: нижний слой — чат, тред — поверх него. Мусор — null. */
export function parseHash(hash: string): StackTarget | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const chatId = Number(p.get('chat'));
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return null;
  const threadId = Number(p.get('thread'));
  return Number.isSafeInteger(threadId) && threadId > 0 ? { chatId, threadId } : { chatId };
}

/** Аргумент openInner: id чата или слой целиком. */
export const toTarget = (to: number | StackTarget): StackTarget => (typeof to === 'number' ? { chatId: to } : to);
