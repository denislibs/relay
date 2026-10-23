import type { Job } from './queue';

/** Повтор бессмыслен (неверный запрос, адресат отвечает 4xx): задача сразу уходит в jobs_dead. */
export class PermanentError extends Error {}

/** again — периодическая задача: перенести на inSec вперёд вместо удаления. */
export type HandlerResult = void | { again: { inSec: number } };
// payload — JSON из базы; каждый обработчик сам знает свою форму
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (payload: any, job: Job) => Promise<HandlerResult>;

/** Обработчики по kind. Доменные модули регистрируются в jobs/kinds.ts (Task 4–6), тесты — через register. */
export const handlers: Record<string, Handler> = {};

export function register(kind: string, h: Handler): void {
  handlers[kind] = h;
}

/**
 * Обработчик пачки задач одного kind (search.sync: один запрос в Meilisearch на сотни сообщений). Успех — все
 * задачи пачки готовы разом; ошибка — воркер прогоняет их по одной через обычный обработчик (он обязателен),
 * поэтому одна «ядовитая» задача не держит остальные, а повторы и PermanentError работают как всегда.
 */
export type BatchHandler = (jobs: Job[]) => Promise<void>;
export const batchHandlers: Record<string, { run: BatchHandler; max: number }> = {};

export function registerBatch(kind: string, run: BatchHandler, opts: { max: number }): void {
  batchHandlers[kind] = { run, max: opts.max };
}
