// Последний пост личного канала (строка «Канал» в профиле): GET /groups/:id — как превью канала до подписки, но без
// превью в сторе и без push'ей. Ответ — в память и в IndexedDB (meta «cpost:<id>») с отметкой времени: повторное
// открытие профиля рисует пост сразу (cached), затем тихо обновляет. Отказ сервера (канал удалён, стал приватным,
// зритель в бане) — кэш стирается, интерфейс схлопывает строку.
import type { Message } from '@relay/protocol';
import { req } from './idb';

export type ChannelPost = { last: Message | null; at: number };
/** gone — сервер канал не показывает: строку прячем */
export type ChannelPostAnswer = ChannelPost | { gone: true } | null;

export interface ChannelPostHost {
  db: IDBDatabase;
  online(): boolean;
  fetch(path: string): Promise<Response>;
}

const key = (id: number) => 'cpost:' + id;

export class ChannelPosts {
  private mem = new Map<number, ChannelPost>();

  constructor(private h: ChannelPostHost) {}

  private async load(id: number): Promise<ChannelPost | null> {
    const hit = this.mem.get(id);
    if (hit) return hit;
    const row = await req(this.h.db.transaction('meta').objectStore('meta').get(key(id))).catch(() => undefined) as { v: ChannelPost } | undefined;
    if (row) this.mem.set(id, row.v);
    return row?.v ?? null;
  }
  private save(id: number, v: ChannelPost | null): void {
    if (v) this.mem.set(id, v); else this.mem.delete(id);
    const os = this.h.db.transaction('meta', 'readwrite').objectStore('meta');
    void req(v ? os.put({ k: key(id), v }) : os.delete(key(id))).catch(() => {});
  }

  /** cached — только кэш, без сети (первый кадр профиля); иначе сервер, без сети или при сбое — кэш. null — не знаем. */
  async get(chatId: number, cached = false): Promise<ChannelPostAnswer> {
    const prev = await this.load(chatId);
    if (cached || !this.h.online()) return prev;
    let res: Response;
    try { res = await this.h.fetch(`/groups/${chatId}`); } catch { return prev; }
    if (res.status === 403 || res.status === 404) { this.save(chatId, null); return { gone: true }; }
    const data = await res.json().catch(() => null) as { chat?: { last?: Message | null } } | null;
    if (!res.ok || !data?.chat) return prev;
    const v = { last: data.chat.last ?? null, at: Date.now() };
    this.save(chatId, v);
    return v;
  }
}
