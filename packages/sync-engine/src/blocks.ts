import type { BlockedUser, PublicUser, Update } from '@relay/protocol';
import type { Ops, PendingOp } from './ops';
import { getAll } from './idb';
import { displayName } from './names';
import type { Store } from './store';
import { Table } from './rows';
import type { Action, Item } from './types';

/** Ключ операций чёрного списка в очереди ops: блокировка и разблокировка одного человека схлопываются. */
export const OP_BLOCK = 'block:';
export const blockKey = (userId: number) => OP_BLOCK + userId;
export const blockIdOf = (key: string): number | null => (key.startsWith(OP_BLOCK) ? Number(key.slice(OP_BLOCK.length)) || null : null);

export interface BlockBase { userId: number; user: PublicUser; at: string }

function baseOf(b: BlockedUser): BlockBase {
  return { userId: b.userId, user: b.user, at: b.at };
}

/**
 * Чёрный список: база — последнее, что сказал сервер (GET /blocks, ответ операции, blocksChanged).
 * Порядок источников — по seq журнала владельца, как у контактов: у каждого человека свой seq (в строке хранилища
 * blocked), снимок поднимает общий пол (meta blocksFloor). Строки пишутся в Store.flush только изменённые.
 */
export class BlocksCache {
  readonly table = new Table<number, BlockBase>();
  loaded = false;
  dirty = false;
  /** seq разблокировки (только в памяти): запоздавшая запись о блокировке не возвращает человека в список */
  private gone = new Map<number, number>();
  private floor = 0;
  private persist = false;

  static async load(db: IDBDatabase, meta: { k: string; v: unknown }[]): Promise<BlocksCache> {
    const c = new BlocksCache();
    c.table.load(await getAll<BlockBase & { seq: number }>(db, 'blocked'), (x) => x.userId);
    const floor = meta.find((m) => m.k === 'blocksFloor')?.v as number | undefined;
    c.floor = floor ?? 0;
    c.loaded = floor !== undefined;   // пол пишется вместе с каждым снимком
    return c;
  }

  private seqOf(id: number): number { return Math.max(this.table.get(id)?.seq ?? this.gone.get(id) ?? 0, this.floor); }

  applyBlocked(b: BlockedUser, seq = b.seq): boolean {
    if (seq !== undefined && seq <= this.seqOf(b.userId)) return false;
    const prev = this.table.get(b.userId);
    this.gone.delete(b.userId);
    if (this.table.put(b.userId, baseOf(b), seq ?? prev?.seq ?? 0)) this.dirty = true;   // эхо — подписки не трогаем
    return true;
  }

  applyUnblocked(userId: number, seq?: number): boolean {
    if (seq !== undefined && seq <= this.seqOf(userId)) return false;
    if (seq !== undefined) this.gone.set(userId, seq);
    if (!this.table.delete(userId)) return true;   // и так нет — подписки не трогаем
    this.dirty = true;
    return true;
  }

  applySnapshot(list: BlockedUser[], seq: number): void {
    const ids = new Set(list.map((b) => b.userId));
    let changed = !this.loaded;
    for (const b of list) if (seq >= this.seqOf(b.userId)) {
      this.gone.delete(b.userId);
      if (this.table.put(b.userId, baseOf(b), seq)) changed = true;
    }
    for (const id of [...this.table.rows.keys()]) if (!ids.has(id) && seq >= this.seqOf(id)) { this.table.delete(id); this.gone.set(id, seq); changed = true; }
    this.floor = Math.max(this.floor, seq);
    this.loaded = true;
    this.persist = true;
    // снимок без перемен — подписки не трогаем, только запоминаем пол
    if (changed) this.dirty = true;
  }

  /** Что дописать в транзакцию flush: изменённые строки, удалённые ключи, meta (пол). */
  collect(): { put: unknown[]; del: number[]; meta: { k: string; v: unknown }[] } {
    const { put, del } = this.table.collect();
    const meta = this.persist ? [{ k: 'blocksFloor', v: this.floor }] : [];
    this.persist = false;
    return { put, del, meta };
  }

  reset(): void {
    this.table.clear();
    this.gone.clear();
    this.floor = 0;
    this.loaded = false;
    this.dirty = true;
    this.persist = false;
  }
}

/** blocksChanged из журнала. */
export function applyBlocksChanged(store: Store, u: Extract<Update, { type: 'blocksChanged' }>, seq?: number): void {
  if (u.blocked) { if (store.blocks.applyBlocked(u.blocked, seq)) store.profile.applyUser(u.blocked.user, seq); }
  else if (u.unblocked) store.blocks.applyUnblocked(u.unblocked, seq);
}

export type BlockView = BlockBase & { pending: boolean };

/** Список, как его видит интерфейс: база + очередь (PUT — заблокирован, DELETE — нет), новые сверху. */
export function blocksView(base: ReadonlyMap<number, BlockBase>, ops: readonly PendingOp[], users: ReadonlyMap<number, PublicUser>): BlockView[] {
  const view = new Map<number, BlockView>();
  for (const [id, b] of base) view.set(id, { ...b, pending: false });
  for (const op of ops) {
    const id = blockIdOf(op.key);
    if (!id) continue;
    if (op.method === 'DELETE') { view.delete(id); continue; }
    const prev = view.get(id);
    const user = prev?.user ?? users.get(id) ?? { id, name: '', firstName: '', lastName: '', username: null, bio: null, birthday: null, phone: null, links: [] };
    view.set(id, { userId: id, user, at: prev?.at ?? new Date(op.at).toISOString(), pending: !prev || prev.pending });
  }
  return [...view.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.userId - a.userId));
}

export interface BlocksHost {
  store: Store;
  ops: Ops;
  http<T>(path: string): Promise<T>;
  run(fn: () => Promise<unknown>): void;
  changed(): void;
}

export type BlockAction = Extract<Action, { type: 'block' | 'unblock' }>;


/** Чёрный список в движке: вид, снимок с сервера, операции. */
export class Blocks {
  constructor(private h: BlocksHost) {}

  private get cache(): BlocksCache { return this.h.store.blocks; }

  view(): BlockView[] { return blocksView(this.cache.table.rows, this.h.ops.list, this.h.store.profile.users.rows); }

  /** Имя, пока сервер не ответил и профиля в кэше нет: как зритель видит человека (контакт с учётом очереди). */
  private chatName(id: number): string { return displayName(this.h.store, id); }

  items(): Item[] {
    const users = this.h.store.profile.users.rows;
    const list: Item[] = this.view().map((b) => {
      const u = users.get(b.userId) ?? b.user;
      return { key: 'b' + b.userId, userId: b.userId, name: u.name || u.publicName || this.chatName(b.userId), username: u.username, phone: u.phone, at: b.at, pending: b.pending, photo: u.photo ?? null };
    });
    list.push({ key: '~blocked', loaded: this.cache.loaded });
    return list;
  }

  /** Список — после каждого hello и после tooLong (журнал мог потерять blocksChanged). */
  fetch(): void {
    this.h.run(async () => {
      const r = await this.h.http<{ blocked: BlockedUser[]; seq: number }>('/blocks');
      this.cache.applySnapshot(r.blocked, r.seq);
      // профиль из снимка — с его seq: более свежий userUpdated он не перетрёт
      for (const b of r.blocked) if (this.cache.table.get(b.userId)) this.h.store.profile.applyUser(b.user, r.seq);
      await this.h.store.flush();
      this.h.changed();
    });
  }

  /** Ответ операции — новая база. false — не наша операция. */
  opDone(op: PendingOp, value: unknown): boolean {
    const id = blockIdOf(op.key);
    if (!id) return false;
    const v = value as (BlockedUser & { unblocked?: number }) | null;
    if (v && typeof v === 'object') {
      if (v.unblocked === id) this.cache.applyUnblocked(id, v.seq);
      else if (v.userId === id && this.cache.applyBlocked(v)) this.h.store.profile.applyUser(v.user, v.seq);
      this.h.run(() => this.h.store.flush());
    }
    return true;
  }

  async act(a: BlockAction): Promise<unknown> {
    const key = blockKey(a.userId);
    if (a.type === 'block') await this.h.ops.enqueue({ key, method: 'PUT', path: `/blocks/${a.userId}` });
    else await this.h.ops.enqueue({ key, method: 'DELETE', path: `/blocks/${a.userId}` });
    return null;
  }
}
