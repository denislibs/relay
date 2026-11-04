// Сохранённые GIF в движке: как мои стикеры — кэш в IndexedDB (meta), изменения через очередь операций, журнал
// ({type:'myGifs'}) двигает gifsRev. Отличия: чтение отвечает из кэша сразу, а сервер спрашивается в фоне (вкладка не ждёт сеть);
// свои неподтверждённые правки лежат в том же кэше и живут, пока их операция в очереди, — переживают перезагрузку и офлайн.
import { SAVED_GIFS_LIMIT, type SavedGif } from '@relay/protocol';
import type { Action } from './types';
import { req } from './idb';
import type { OpSpec, PendingOp } from './ops';

export type GifsAction = Extract<Action, { type: 'savedGifs' | 'saveGif' | 'removeGif' }>;
export const OP_GIF = 'gifs:';

export interface GifsHost {
  db: IDBDatabase;
  online(): boolean;
  http<T>(path: string, init: { method: string; body?: string }): Promise<T>;
  enqueue(op: OpSpec): Promise<void>;
  pending(key: string): boolean;   // операция с этим ключом ещё в очереди
  run(fn: () => Promise<unknown>): void;
  rev(): number;    // gifsRev: растёт от журнала, снимка и каждого подключения
  bump(): void;     // gifsRev++ и changed(): интерфейс перечитает
}

interface Edit { on: boolean; gif?: SavedGif }
interface Cached { base: SavedGif[] | null; edits: [string, Edit][] }
const META = 'gifs:mine';

export class SavedGifs {
  private base: SavedGif[] | null = null;   // ответ сервера; null — ещё ни разу не спрашивали
  private edits = new Map<string, Edit>();
  private loaded: Promise<void> | null = null;
  private synced = -1;       // gifsRev, на который список уже спрошен
  private fetching = false;
  private acks = 0;          // подтверждённых операций: ответ, ушедший до подтверждения, устарел

  constructor(private h: GifsHost) {}

  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      const row = await req(this.h.db.transaction('meta').objectStore('meta').get(META)) as { v: Cached } | undefined;
      if (!row) return;
      this.base = row.v.base;
      this.edits = new Map(row.v.edits);
    })().catch(() => {});
  }
  private save(): void {
    const v: Cached = { base: this.base, edits: [...this.edits] };
    void req(this.h.db.transaction('meta', 'readwrite').objectStore('meta').put({ k: META, v })).catch(() => {});
  }
  /** Своё изменение: поднять rev, но не спрашивать сервер из-за него. */
  private bumpOwn(): void {
    const fresh = this.synced === this.h.rev();
    this.h.bump();
    if (fresh) this.synced = this.h.rev();
  }

  /** База + неподтверждённые правки: новые сверху, не больше лимита. */
  private view(): SavedGif[] {
    let list = this.base ?? [];
    for (const [id, e] of this.edits) {
      list = list.filter((g) => g.id !== id);
      if (e.on && e.gif) list = [e.gif, ...list];
    }
    return [...list].sort((a, b) => b.savedAt - a.savedAt).slice(0, SAVED_GIFS_LIMIT);
  }

  /** Файл в сохранённых: истёкшее сообщение с той же GIF не должно убирать его ключ с устройства. */
  has(id: string): boolean { return this.view().some((g) => g.id === id); }

  async act(a: GifsAction): Promise<unknown> {
    await this.load();
    switch (a.type) {
      case 'savedGifs':
        this.sync();
        // loaded: false — кэша нет и ответ ещё в пути: это не «пусто», пустое состояние не показываем
        return { list: this.view(), loaded: this.base !== null || !this.h.online() };
      case 'saveGif': {
        this.edits.set(a.gif.id, { on: true, gif: { ...a.gif, savedAt: Date.now() } });
        this.save(); this.bumpOwn();
        await this.h.enqueue({ key: OP_GIF + a.gif.id, method: 'POST', path: '/my-gifs', body: { chatId: a.chatId, messageId: a.messageId } });
        return null;
      }
      case 'removeGif': {
        this.edits.set(a.id, { on: false });
        this.save(); this.bumpOwn();
        await this.h.enqueue({ key: OP_GIF + a.id, method: 'DELETE', path: `/my-gifs/${encodeURIComponent(a.id)}` });
        return null;
      }
    }
  }

  /** Сервер спрашивается, только если gifsRev ушёл вперёд с прошлого ответа; ключи и миниатюры уже известных он не присылает. */
  private sync(): void {
    if (this.fetching || !this.h.online() || this.synced === this.h.rev()) return;
    this.fetching = true;
    const at = this.h.rev(), acks = this.acks;
    this.h.run(async () => {
      try {
        const known = new Map<string, SavedGif>();
        for (const g of this.base ?? []) known.set(g.id, g);
        for (const e of this.edits.values()) if (e.gif) known.set(e.gif.id, e.gif);
        const r = await this.h.http<{ list: SavedGif[] }>('/my-gifs/list', { method: 'POST', body: JSON.stringify({ have: [...known.keys()].filter((id) => !!known.get(id)!.key || !known.get(id)!.enc) }) });
        if (acks !== this.acks) return;   // пока шёл запрос, подтвердилась операция: её в этом ответе может не быть — спросим заново (finally)
        const next = r.list.map((g) => { const k = known.get(g.id); return k && g.key === undefined ? { ...g, name: k.name, ...(k.key ? { key: k.key } : {}), thumb: k.thumb ?? null } : g; });
        const before = JSON.stringify(this.view());
        this.base = next;
        for (const id of this.edits.keys()) if (!this.h.pending(OP_GIF + id)) this.edits.delete(id);
        this.save();
        this.synced = at;
        if (JSON.stringify(this.view()) !== before) this.bumpOwn();
      } catch { /* сети нет — следующий gifsRev спросит снова */ }
      finally {
        this.fetching = false;
        if (this.synced !== this.h.rev()) this.sync();
      }
    });
  }

  /** 2xx: ответ — новая база, иначе между уходом операции и приходом журнала плитка мигнула бы (ops.ts, ПРАВИЛО). */
  opDone(op: PendingOp, value: unknown): void {
    const id = op.key.slice(OP_GIF.length);
    this.acks++;
    if (op.method === 'POST') {
      const v = value as { gif?: SavedGif; evicted?: string[] } | null;
      if (v?.gif) {
        const gone = new Set(v.evicted ?? []);
        this.base = [v.gif, ...(this.base ?? []).filter((g) => g.id !== v.gif!.id && !gone.has(g.id))];
      }
    } else if (this.base) this.base = this.base.filter((g) => g.id !== id);
    if (!this.h.pending(op.key)) this.edits.delete(id);
    this.save();
    this.bumpOwn();
  }

  /** Сервер отказал (защищённый чат, сообщение удалено): оптимистичная правка неправда — вернуть то, что на сервере. */
  opFailed(key: string): void {
    const id = key.slice(OP_GIF.length);
    if (!this.h.pending(key)) this.edits.delete(id);
    this.save();
    this.acks++;
    this.synced = -1;
    this.h.bump();
  }
}
