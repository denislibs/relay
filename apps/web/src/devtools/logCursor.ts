// Курсор по журналу движка: id событий растут внутри одной эпохи (ep — экземпляр движка).
// После «Перезапустить воркер» эпоха новая, id снова с 1 — курсор старой эпохи новые события не прячет.

export interface LogCursor { ep: string | null; id: number }
export const START: LogCursor = { ep: null, id: 0 };

const epOf = (e: Record<string, unknown>): string | null => (typeof e.ep === 'string' ? e.ep : null);

/** Событие новее курсора: другая эпоха — всегда новее. */
export const isAfter = (e: Record<string, unknown>, c: LogCursor): boolean => epOf(e) !== c.ep || Number(e.id) > c.id;

/** Курсор на событии (последнем увиденном). */
export const cursorAt = (e: Record<string, unknown> | undefined): LogCursor => (e ? { ep: epOf(e), id: Number(e.id) } : START);

/** Ключ кэша сводок: в разных эпохах e1… — разные события. */
export const eventKey = (e: Record<string, unknown> & { key: string }): string => (epOf(e) ?? '') + ':' + e.key;
