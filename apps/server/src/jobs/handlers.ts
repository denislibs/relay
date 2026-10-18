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
