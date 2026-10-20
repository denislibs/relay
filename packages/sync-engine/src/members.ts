import type { Me, MemberRow, ProfilePhoto } from '@relay/protocol';
import { getAll } from './idb';
import { personView } from './names';
import { Table, type Row } from './rows';
import type { Store } from './store';
import type { Item } from './types';

/** Пределы хранения: группа до MEMBERS_FULL — список целиком, больше — первые MEMBERS_PART. */
export const MEMBERS_FULL = 1000;
export const MEMBERS_PART = 200;

/** Строка участника: роль и должность, order — место в списке (порядок ответа сервера, новые — в конец). */
export type MemberBase = MemberRow & { chatId: number; order: number };
type Presence = { online: boolean | null; lastSeen: string | null };
/** Ответ GET /chats/:id/members (сервер: онлайн сверху, до 1000, без системных). */
export type MembersReply = { ownerId: number | null; members: (MemberRow & Presence & { name: string; username: string | null; photo?: ProfilePhoto | null })[] };

const keyOf = (chatId: number, userId: number) => chatId + ':' + userId;

/**
 * Участники групп: строки в IndexedDB (members, ключ [chatId, userId]), в памяти — таблица и индекс по чату.
 * База — последний снимок GET /chats/:id/members, поверх — записи журнала members (seq не даёт снимку,
 * начатому раньше записи, её откатить). Присутствие здесь не хранится — оно у движка, только в памяти.
 */
export class MembersCache {
  readonly table = new Table<string, MemberBase>();
  /** чаты, чей состав изменился с последнего прохода подписок */
  readonly touched = new Set<number>();
  private byChat = new Map<number, Set<string>>();
  private sorted = new Map<number, Row<MemberBase>[]>();
  /** номер изменения состава по чату (только в памяти): по нему старый интерфейс перечитывает списки (membersRev) */
  private revs = new Map<number, number>();
  /** seq удаления (только в памяти): снимок, начатый до записи журнала, не воскрешает удалённого */
  private gone = new Map<string, number>();
  /** чаты, чей первый снимок ещё в пути: записи журнала копятся в таблице, снимок их не откатит (seq) */
  readonly loading = new Set<number>();

  static async load(db: IDBDatabase): Promise<MembersCache> {
    const c = new MembersCache();
    const rows = await getAll<MemberBase & { seq: number }>(db, 'members');
    c.table.load(rows, (x) => keyOf(x.chatId, x.userId));
    for (const r of rows) c.keys(r.chatId).add(keyOf(r.chatId, r.userId));
    return c;
  }

  private keys(chatId: number): Set<string> {
    let s = this.byChat.get(chatId);
    if (!s) { s = new Set(); this.byChat.set(chatId, s); }
    return s;
  }
  private touch(chatId: number): void { this.touched.add(chatId); this.sorted.delete(chatId); }

  /** Участники чата по порядку. Массив кэшируется до следующего изменения — не мутировать. */
  list(chatId: number): Row<MemberBase>[] {
    let arr = this.sorted.get(chatId);
    if (!arr) {
      arr = [...(this.byChat.get(chatId) ?? [])].map((k) => this.table.get(k)!).filter(Boolean).sort((a, b) => a.order - b.order);
      this.sorted.set(chatId, arr);
    }
    return arr;
  }

  rev(chatId: number): number { return this.revs.get(chatId) ?? 0; }
  bump(chatId: number): void { this.revs.set(chatId, this.rev(chatId) + 1); }

  private put(chatId: number, m: MemberRow, order: number, seq: number): boolean {
    const k = keyOf(chatId, m.userId);
    if ((this.gone.get(k) ?? 0) > seq) return false;
    if (!this.table.put(k, { chatId, userId: m.userId, role: m.role, rank: m.rank ?? null, order }, seq)) return false;
    this.gone.delete(k);
    this.keys(chatId).add(k);
    return true;
  }
  private remove(chatId: number, userId: number, seq: number): boolean {
    const k = keyOf(chatId, userId);
    if ((this.table.get(k)?.seq ?? 0) > seq) return false;
    if (seq) this.gone.set(k, Math.max(this.gone.get(k) ?? 0, seq));
    this.byChat.get(chatId)?.delete(k);
    return this.table.delete(k);
  }

  /** Снимок списка на момент seq: порядок — как у сервера; кого нет в снимке и чья строка не новее — убрать. */
  applySnapshot(chatId: number, list: MemberRow[], seq: number): void {
    const ids = new Set(list.map((m) => m.userId));
    let changed = false;
    // строка новее снимка (запись журнала, пришедшая, пока он шёл) остаётся, но место берёт по снимку: свой seq — только порядок
    const reorder = (k: string, order: number) => {
      const r = this.table.get(k);
      if (r && r.order !== order && this.table.put(k, { chatId, userId: r.userId, role: r.role, rank: r.rank, order }, r.seq)) changed = true;
    };
    list.forEach((m, i) => { if (this.put(chatId, m, i, seq)) changed = true; else reorder(keyOf(chatId, m.userId), i); });
    for (const r of this.list(chatId)) if (!ids.has(r.userId) && this.remove(chatId, r.userId, seq)) changed = true;
    this.sorted.delete(chatId);
    // новее снимка и не в нём (добавлены после) — в конец, в прежнем порядке
    let tail = list.length;
    for (const r of this.list(chatId)) if (!ids.has(r.userId)) reorder(keyOf(chatId, r.userId), tail++);
    if (changed) this.touch(chatId);
  }

  /** Запись журнала members: новые — в конец, у известных меняются роль и должность (место прежнее). */
  applyDelta(chatId: number, upsert: MemberRow[], remove: number[], seq: number): void {
    let changed = false;
    for (const id of remove) if (this.remove(chatId, id, seq)) changed = true;
    let max = this.list(chatId).reduce((n, r) => Math.max(n, r.order), -1);
    for (const m of upsert) {
      const prev = this.table.get(keyOf(chatId, m.userId));
      if (this.put(chatId, m, prev ? prev.order : ++max, seq)) changed = true;
    }
    if (changed) this.touch(chatId);
  }

  /** Чат больше не мой: все его строки — из памяти и IndexedDB. */
  dropChat(chatId: number): void {
    const keys = this.byChat.get(chatId);
    if (!keys?.size) return;
    for (const k of keys) this.table.delete(k);
    this.byChat.delete(chatId);
    this.touch(chatId);
  }

  /** Уборка (evict.ts): оставить первых n по порядку; вернёт, сколько строк убрано. */
  trim(chatId: number, n: number): number {
    const extra = this.list(chatId).slice(n);
    for (const r of extra) { const k = keyOf(chatId, r.userId); this.byChat.get(chatId)?.delete(k); this.table.delete(k); }
    if (extra.length) this.touch(chatId);
    return extra.length;
  }

  /** Что дописать в транзакцию flush: ключ IndexedDB — [chatId, userId]. */
  collect(): { put: unknown[]; del: [number, number][] } {
    const { put, del } = this.table.collect();
    return { put, del: del.map((k) => { const [c, u] = k.split(':'); return [Number(c), Number(u)] as [number, number]; }) };
  }

  reset(): void {
    for (const id of this.byChat.keys()) this.touched.add(id);
    this.table.clear(); this.byChat.clear(); this.sorted.clear(); this.gone.clear(); this.revs.clear(); this.loading.clear();
  }
}

/** Снимок участников с сервера (на момент seq): строки, профили в people (поверх известного), «загружено целиком». */
export function applyMembersReply(store: Store, chatId: number, r: MembersReply, seq: number): void {
  store.members.loading.delete(chatId);
  const chat = store.chats.get(chatId);
  if (!chat) return;
  // сервер отдаёт не больше MEMBERS_FULL: больше ли группа — видно по числу участников в group
  const done = Math.max(r.members.length, chat.group?.members ?? 0) <= MEMBERS_FULL;
  const list = done ? r.members : r.members.slice(0, MEMBERS_PART);
  store.members.applySnapshot(chatId, list.map((m) => ({ userId: m.userId, role: m.role ?? 'member', rank: m.rank ?? null })), seq);
  for (const m of list) store.profile.applyPeer({ id: m.userId, name: m.name, username: m.username, photo: m.photo ?? null }, seq);
  if (chat.membersDone !== done) { chat.membersDone = done; store.markChat(chat); }
  store.members.touched.add(chatId);   // «загружено» могло смениться и без строк
}

/** Запись журнала members: только если состав уже загружали (иначе следующее открытие возьмёт его целиком); себя убрали — забыть. */
export function applyMembersUpdate(store: Store, chatId: number, upsert: MemberRow[], remove: number[], seq = 0): void {
  const chat = store.chats.get(chatId);
  store.members.bump(chatId);
  store.retouch(chatId);   // membersRev в строке чата
  if (!chat || (chat.membersDone === undefined && !store.members.loading.has(chatId))) return;
  if (remove.includes(store.userId)) {
    store.members.loading.delete(chatId);
    store.members.dropChat(chatId);
    delete chat.membersDone;
    store.markChat(chat);
    return;
  }
  store.members.applyDelta(chatId, upsert, remove, seq);
}

/**
 * Подписка members: строка на участника по order — роль, должность, имя и фото (как видит зритель, names.ts),
 * присутствие (из памяти движка). Служебный ~members {loaded, complete}: состав уже загружали / загружен целиком.
 */
export function membersResult(store: Store, chatId: number, presence: ReadonlyMap<number, Presence>, me: Me | null): { items: Map<string, Item>; order: string[]; sig: Map<string, string> } {
  const items = new Map<string, Item>(), sig = new Map<string, string>(), order: string[] = [];
  for (const r of store.members.list(chatId)) {
    const key = String(r.userId);
    let name: string, photo: ProfilePhoto | null, g: string, p: Presence | undefined;
    if (r.userId === store.userId) {
      name = me?.name ?? ''; photo = me?.photo ?? null; g = 'me:' + JSON.stringify([name, photo]);
      p = { online: true, lastSeen: null };   // себя зритель видит в сети
    } else {
      const v = personView(store, r.userId);
      if (!store.users.get(r.userId)) store.wantUser(r.userId);   // профиль вытеснили — движок спросит
      name = v.name; photo = v.photo; g = v.sig; p = presence.get(r.userId);
    }
    const online = p?.online ?? false, lastSeen = p?.lastSeen ?? null;
    items.set(key, { key, userId: r.userId, role: r.role, rank: r.rank, name, photo, online, lastSeen });
    sig.set(key, `${r.v}|${g}|${online}|${lastSeen}`);
    order.push(key);
  }
  const done = store.chats.get(chatId)?.membersDone;
  const meta: Item = { key: '~members', loaded: done !== undefined, complete: done === true };
  items.set(meta.key, meta); sig.set(meta.key, `${meta.loaded}|${meta.complete}`); order.push(meta.key);
  return { items, order, sig };
}
