import type { LocalChat, LocalMessage } from './types';

/*
 * Канал на клиенте: посты от имени канала (senderId 0) и просмотры. Пишут только админы с правом post;
 * «печатает…» в канале не показывается; реакции поста — счётчики (reactionCounts) и моя (myReaction).
 */

/** Пост канала: в ленте — слева, без аватара и имени, даже свой (mine для вида — false). */
export const isPost = (m: Pick<LocalMessage, 'post'> | null | undefined): boolean => !!m?.post;

/** Можно ли писать в чат: в канале — только админу с правом post (подписчику — нижняя панель вместо поля ввода). */
export const canPost = (c: Pick<LocalChat, 'kind' | 'me'>): boolean => c.kind !== 'channel' || !!c.me?.admin?.post;

/** Счётчики после смены своей реакции (оптимистично, до ответа сервера): старая −1, новая +1, больше — раньше. */
export function shiftCounts(counts: [string, number][], prev: string | null, next: string | null): [string, number][] {
  const by = new Map(counts);
  if (prev) { const n = (by.get(prev) ?? 0) - 1; if (n > 0) by.set(prev, n); else by.delete(prev); }
  if (next) by.set(next, (by.get(next) ?? 0) + 1);
  return [...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export interface ViewsDeps {
  online(): boolean;
  /** POST /chats/:id/views {ids} → {views: [[id, n]]}; ошибка (flood, сеть) — бросает */
  post(chatId: number, ids: number[]): Promise<{ views: [number, number][] }>;
  apply(chatId: number, views: [number, number][]): void;
  run(fn: () => Promise<unknown>): void;
  everyMs: number;
}

/**
 * Просмотры постов: каждый пост — один раз за сессию (seenPosts в памяти), запрос не чаще раза в everyMs и по одному
 * чату за раз (лимит сервера — запрос в секунду на пользователя), до 100 id. Не ушло (нет сети, отказ) — id
 * возвращаются в очередь и уйдут следующим тиком.
 */
export class ViewCounter {
  static readonly MAX = 100;
  private seen = new Map<number, Set<number>>();
  private queued = new Map<number, Set<number>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastAt = 0;
  private inFlight = false;
  private closed = false;
  constructor(private deps: ViewsDeps) {}

  add(chatId: number, ids: number[]): void {
    const seen = this.seen.get(chatId);
    let q = this.queued.get(chatId);
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id <= 0 || seen?.has(id)) continue;
      if (!q) { q = new Set(); this.queued.set(chatId, q); }
      q.add(id);
    }
    this.schedule();
  }

  /** Есть ли что отправить (тесты, whenIdle не ждёт тикающий таймер). */
  get pending(): boolean { return this.queued.size > 0 || this.inFlight; }

  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }

  private schedule(): void {
    if (this.closed || this.timer || this.inFlight || !this.queued.size) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(0, this.lastAt + this.deps.everyMs - Date.now()));
  }

  private flush(): void {
    if (this.closed || !this.queued.size) return;
    if (!this.deps.online()) { this.lastAt = Date.now(); this.schedule(); return; }   // без сети — ждём, проверяя раз в тик
    const [chatId, set] = this.queued.entries().next().value as [number, Set<number>];
    const ids = [...set].slice(0, ViewCounter.MAX);
    for (const id of ids) set.delete(id);
    if (!set.size) this.queued.delete(chatId);
    this.inFlight = true;
    this.lastAt = Date.now();
    this.deps.run(async () => {
      const markSeen = () => {
        let seen = this.seen.get(chatId);
        if (!seen) { seen = new Set(); this.seen.set(chatId, seen); }
        for (const id of ids) seen.add(id);
      };
      try {
        const res = await this.deps.post(chatId, ids);
        markSeen();
        this.deps.apply(chatId, res.views);
      } catch (err) {
        // нет сети или лимит (429) — в очередь обратно, уйдут следующим тиком; иной отказ (не участник) — не повторять
        const msg = String((err as Error)?.message ?? '');
        if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) markSeen();
        else this.add(chatId, ids);
      } finally {
        this.inFlight = false;
        this.lastAt = Date.now();
        this.schedule();
      }
    });
  }
}
