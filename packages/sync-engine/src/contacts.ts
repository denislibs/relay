import type { Contact, PublicUser, Update } from '@relay/protocol';
import type { Ops, PendingOp } from './ops';
import { getAll } from './idb';
import type { Store } from './store';
import { Table } from './rows';
import { cleanName, cleanText } from './text';
import type { Action, Item } from './types';

/** Ключ операций контакта в очереди ops: добавление, правка и удаление одного человека схлопываются друг с другом. */
export const OP_CONTACT = 'contact:';
export const contactKey = (userId: number) => OP_CONTACT + userId;
export const contactIdOf = (key: string): number | null => (key.startsWith(OP_CONTACT) ? Number(key.slice(OP_CONTACT.length)) || null : null);

export interface ContactBase { userId: number; firstName: string; lastName: string; note: string; user: PublicUser; presence?: { online: boolean | null; lastSeen: string | null } }
export interface ContactView extends ContactBase { pending: boolean }
type Presence = { online: boolean | null; lastSeen: string | null };

export const contactName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();

function baseOf(c: Contact): ContactBase {
  const { seq: _seq, ...rest } = c;
  return rest;
}

/**
 * Контакты: база — последнее, что сказал сервер (GET /contacts, ответ операции, contactsChanged).
 * Источники приходят вразнобой — упорядочивает seq журнала владельца: у каждого контакта свой seq (в строке хранилища
 * contacts), снимок списка поднимает общий пол (всё, что не новее снимка, уже в нём учтено).
 * Пол и «снимок был» — в meta (contactsFloor, contactsLoaded); строки пишутся в Store.flush только изменённые.
 */
export class ContactsCache {
  readonly table = new Table<number, ContactBase>();
  /** снимок с сервера уже был (иначе пустой список — это «ещё не знаем») */
  loaded = false;
  /** изменилось с последнего прохода подписок */
  dirty = false;
  /** растёт при каждом изменении базы (мемо вида) */
  version = 0;
  /** у кого контакт появился/пропал/переименован с последнего прохода: id → запись до изменения */
  private changedIds = new Map<number, ContactBase | undefined>();
  /** seq удаления (только в памяти): запоздавшая запись о контакте не воскрешает удалённого */
  private gone = new Map<number, number>();
  private floor = 0;
  private persist = false;

  static async load(db: IDBDatabase, meta: { k: string; v: unknown }[]): Promise<ContactsCache> {
    const c = new ContactsCache();
    c.table.load(await getAll<ContactBase & { seq: number }>(db, 'contacts'), (x) => x.userId);
    c.floor = (meta.find((m) => m.k === 'contactsFloor')?.v as number | undefined) ?? 0;
    c.loaded = !!meta.find((m) => m.k === 'contactsLoaded')?.v;
    return c;
  }

  private seqOf(id: number): number { return Math.max(this.table.get(id)?.seq ?? this.gone.get(id) ?? 0, this.floor); }
  private touch(): void { this.dirty = true; this.version++; }
  private before(id: number, prev: ContactBase | undefined): void { if (!this.changedIds.has(id)) this.changedIds.set(id, prev); }

  /** Контакт добавлен/изменён. seq — номер записи журнала (или ответа); не новее известного — не трогаем. */
  applyContact(c: Contact, seq = c.seq): boolean {
    if (seq !== undefined && seq <= this.seqOf(c.userId)) return false;
    const prev = this.table.get(c.userId);
    this.gone.delete(c.userId);
    // то же самое (эхо своей правки): seq запоминается в таблице, подписки не трогаем
    if (this.table.put(c.userId, baseOf(c), seq ?? prev?.seq ?? 0)) {
      this.before(c.userId, prev);
      this.touch();
    }
    return true;
  }

  applyRemoved(userId: number, seq?: number): boolean {
    if (seq !== undefined && seq <= this.seqOf(userId)) return false;
    if (seq !== undefined) this.gone.set(userId, seq);
    const prev = this.table.get(userId);
    if (!prev) return true;   // и так нет — подписки не трогаем
    this.before(userId, prev);
    this.table.delete(userId);
    this.touch();
    return true;
  }

  /** Весь список на момент seq: всё, что не новее, заменяется снимком. */
  applySnapshot(list: Contact[], seq: number): void {
    const ids = new Set(list.map((c) => c.userId));
    let changed = !this.loaded;
    for (const c of list) if (seq >= this.seqOf(c.userId)) {
      const prev = this.table.get(c.userId);
      this.gone.delete(c.userId);
      if (this.table.put(c.userId, baseOf(c), seq)) {
        if (!prev || contactName(prev) !== contactName(c)) this.before(c.userId, prev);
        changed = true;
      }
    }
    for (const [id, prev] of [...this.table.rows]) if (!ids.has(id) && seq >= this.seqOf(id)) { this.before(id, prev); this.table.delete(id); this.gone.set(id, seq); changed = true; }
    this.floor = Math.max(this.floor, seq);
    this.loaded = true;
    this.persist = true;
    // снимок без перемен (после каждого hello) — подписки не трогаем, только запоминаем пол
    if (changed) this.touch();
  }

  /** Чьи контакты изменились в базе (и какими были до того) — забрать для починки кэша профиля. */
  takeChanged(): Map<number, ContactBase | undefined> {
    const r = this.changedIds;
    this.changedIds = new Map();
    return r;
  }

  /** Что дописать в транзакцию flush: изменённые строки, удалённые ключи, meta (пол и «загружено»). */
  collect(): { put: unknown[]; del: number[]; meta: { k: string; v: unknown }[] } {
    const { put, del } = this.table.collect();
    const meta = this.persist ? [{ k: 'contactsFloor', v: this.floor }, { k: 'contactsLoaded', v: this.loaded ? 1 : 0 }] : [];
    this.persist = false;
    return { put, del, meta };
  }

  /** База сервера пересоздана: всё забыть; «загружено» — только после настоящего GET /contacts. */
  reset(): void {
    this.table.clear();
    this.gone.clear();
    this.changedIds.clear();
    this.floor = 0;
    this.loaded = false;
    this.persist = true;
    this.touch();
  }
}

/** Контакты, как их видит интерфейс: база + ещё не подтверждённые операции из очереди (по порядку). */
export function contactsView(base: ReadonlyMap<number, ContactBase>, ops: readonly PendingOp[], users: ReadonlyMap<number, PublicUser>): Map<number, ContactView> {
  const view = new Map<number, ContactView>();
  for (const [id, c] of base) view.set(id, { ...c, pending: false });
  for (const op of ops) {
    const id = contactIdOf(op.key);
    if (!id) continue;
    const prev = view.get(id);
    const b = (op.body ?? {}) as { firstName?: string; lastName?: string; note?: string };
    if (op.method === 'DELETE') { view.delete(id); continue; }
    if (op.method === 'POST') {
      const user = prev?.user ?? users.get(id) ?? { id, name: '', firstName: '', lastName: '', username: null, bio: null, birthday: null, phone: null, links: [] };
      view.set(id, {
        userId: id, firstName: cleanName(b.firstName ?? ''), lastName: cleanName(b.lastName ?? ''),
        note: b.note !== undefined ? cleanText(b.note) : prev?.note ?? '', user, presence: prev?.presence, pending: true,
      });
    } else if (op.method === 'PATCH' && prev) {
      view.set(id, {
        ...prev,
        firstName: b.firstName !== undefined ? cleanName(b.firstName) : prev.firstName,
        lastName: b.lastName !== undefined ? cleanName(b.lastName ?? '') : prev.lastName,
        note: b.note !== undefined ? cleanText(b.note ?? '') : prev.note,
        pending: true,
      });
    }
  }
  return view;
}

/** Элементы подписки contacts: контакт + профиль + присутствие (живое — из движка, иначе из ответа сервера). */
export function contactItems(view: Map<number, ContactView>, users: ReadonlyMap<number, PublicUser>, presence: ReadonlyMap<number, Presence>): Item[] {
  const out: Item[] = [];
  for (const c of view.values()) {
    const u = users.get(c.userId) ?? c.user;
    const p = presence.get(c.userId) ?? c.presence ?? null;
    out.push({
      key: 'k' + c.userId, userId: c.userId, firstName: c.firstName, lastName: c.lastName, note: c.note,
      name: contactName(c) || u.publicName || u.name, publicName: u.publicName ?? c.user.publicName ?? null,
      username: u.username, phone: u.phone, birthday: u.birthday ?? null, online: p?.online ?? false, lastSeen: p?.lastSeen ?? null, known: !!p, pending: c.pending, photo: u.photo ?? null,
    });
  }
  return out;
}

/** contactsChanged из журнала: база контактов и профиль в кэше (кэш профиля чинит Contacts.repair на проходе подписок). */
export function applyContactsChanged(store: Store, u: Extract<Update, { type: 'contactsChanged' }>, seq?: number): void {
  if (u.contact) {
    if (store.contacts.applyContact(u.contact, seq)) store.profile.applyUser(u.contact.user);
  } else if (u.removed) {
    if (store.contacts.applyRemoved(u.removed, seq) && u.user) store.profile.applyUser(u.user);
  }
}

/** Что движок даёт контактам. */
export interface ContactsHost {
  store: Store;
  ops: Ops;
  httpBase: string;
  headers?: Record<string, string>;
  /** HTTP движка (dev: имитатор сети); по умолчанию fetch */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  online(): boolean;
  presence(): ReadonlyMap<number, Presence>;
  /** присутствие из ответа сервера, если живого ещё нет */
  seedPresence(userId: number, p: Presence): void;
  /** перезапросить GET /users/:id (контактное имя в кэше устарело) */
  refreshUser(userId: number): void;
  http<T>(path: string): Promise<T>;
  run(fn: () => Promise<unknown>): void;
  changed(): void;
}

export type ContactAction = Extract<Action, { type: 'addContact' | 'updateContact' | 'removeContact' | 'resolveUser' }>;
export const isContactAction = (a: Action): a is ContactAction =>
  a.type === 'addContact' || a.type === 'updateContact' || a.type === 'removeContact' || a.type === 'resolveUser';

/** Контакты в движке: вид (база + очередь), операции, снимок с сервера. */
export class Contacts {
  private memo: { version: number; ops: readonly PendingOp[]; view: Map<number, ContactView> } | null = null;

  constructor(private h: ContactsHost) {}

  private get cache(): ContactsCache { return this.h.store.contacts; }

  /** База + очередь (мемо до изменения базы или очереди). */
  view(): Map<number, ContactView> {
    const m = this.memo, c = this.cache, ops = this.h.ops.list;
    if (m && m.version === c.version && m.ops === ops) return m.view;
    const view = contactsView(c.table.rows, ops, this.h.store.profile.users.rows);
    this.memo = { version: c.version, ops, view };
    return view;
  }

  private publicName(id: number, was?: ContactBase): string | null {
    return this.h.store.profile.users.get(id)?.publicName ?? was?.user.publicName ?? null;
  }

  /** Результат подписки contacts. */
  items(): Item[] {
    const c = this.cache;
    const list = c.loaded || this.h.ops.list.some((o) => contactIdOf(o.key)) ? contactItems(this.view(), this.h.store.profile.users.rows, this.h.presence()) : [];
    // служебный элемент: снимок с сервера уже был (иначе пустой список — «ещё грузим», а не «нет контактов»)
    list.push({ key: '~contacts', loaded: c.loaded });
    return list;
  }

  /**
   * Перед проходом подписок: контакт пропал из базы (снимок, журнал, ответ — в любом порядке) — в кэше профиля
   * могла остаться запись с контактным именем: исправить сразу и перезапросить с сервера. Названия чатов
   * не переписываем — их считает names.ts, а строки списка пересчитывает PeerSigs.
   */
  repair(): void {
    const store = this.h.store;
    for (const [id, was] of this.cache.takeChanged()) {
      if (this.cache.table.get(id)) continue;
      const pub = this.publicName(id, was);
      const u = store.profile.users.get(id);
      if (u && pub && u.name !== pub) {
        const sp = pub.indexOf(' ');
        store.profile.applyUser({ ...u, name: pub, firstName: sp < 0 ? pub : pub.slice(0, sp), lastName: sp < 0 ? '' : pub.slice(sp + 1) });
      }
      this.h.refreshUser(id);
    }
  }

  /** Контакт с сервера (снимок или ответ): профиль — в кэш, присутствие — если живого ещё нет. */
  private take(c: Contact): void {
    this.h.store.profile.applyUser(c.user);
    if (c.presence) this.h.seedPresence(c.userId, c.presence);
  }

  /** Список контактов — после каждого hello и после tooLong (журнал мог потерять contactsChanged). */
  fetch(): void {
    this.h.run(async () => {
      const r = await this.h.http<{ contacts: Contact[]; seq: number }>('/contacts');
      this.cache.applySnapshot(r.contacts, r.seq);
      for (const c of r.contacts) if (this.cache.table.get(c.userId)) this.take(c);
      this.repair();
      await this.h.store.flush();
      this.h.changed();
    });
  }

  /** Ответ операции контакта — новая база (журнал принесёт то же самое ещё раз — seq не даст откатить). false — не наша операция. */
  opDone(op: PendingOp, value: unknown): boolean {
    const cid = contactIdOf(op.key);
    if (!cid) return false;
    if (value && typeof value === 'object') {
      const v = value as Contact & { removed?: number; user?: PublicUser | null; seq?: number };
      if (v.removed === cid) {
        if (this.cache.applyRemoved(cid, v.seq) && v.user) this.h.store.profile.applyUser(v.user);
      } else if (v.userId === cid && this.cache.applyContact(v)) {
        this.take(v);
      }
      this.repair();
      this.h.run(() => this.h.store.flush());
    }
    return true;
  }

  async act(a: ContactAction): Promise<unknown> {
    const ops = this.h.ops;
    switch (a.type) {
      case 'addContact':
        await ops.enqueue({ key: contactKey(a.userId), method: 'POST', path: '/contacts', body: { userId: a.userId, firstName: a.firstName, lastName: a.lastName ?? '', ...(a.note !== undefined ? { note: a.note } : {}) } });
        return null;
      case 'updateContact': {
        if (!this.view().has(a.userId)) return null;   // контакта нет (или уже удаляется) — править нечего
        const patch: Record<string, unknown> = {};
        for (const k of ['firstName', 'lastName', 'note'] as const) if (a[k] !== undefined) patch[k] = a[k];
        if (!Object.keys(patch).length) return null;
        // добавление ещё не подтверждено: правку — в само добавление (POST — upsert), иначе PATCH ушёл бы раньше контакта
        const key = contactKey(a.userId);
        const post = [...ops.list].reverse().find((o) => o.key === key);
        if (post?.method === 'POST') await ops.enqueue({ key, method: 'POST', path: '/contacts', body: { ...(post.body as object), ...patch } });
        else await ops.enqueue({ key, method: 'PATCH', path: `/contacts/${a.userId}`, body: patch });
        return null;
      }
      case 'removeContact':
        await ops.enqueue({ key: contactKey(a.userId), method: 'DELETE', path: `/contacts/${a.userId}` });
        return null;
      case 'resolveUser': {
        if (!this.h.online()) return { offline: true };
        let res: Response;
        try {
          // POST: номер телефона — в теле, не в URL
          res = await (this.h.fetch ?? fetch)(`${this.h.httpBase}/users/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.h.headers ?? {}) }, credentials: 'include', body: JSON.stringify({ query: a.query }) });
        } catch { return { offline: true }; }
        if (res.status === 404) return { notFound: true };
        if (!res.ok) return { offline: true };
        const u = (await res.json()) as PublicUser;
        this.h.store.profile.applyUser(u);   // добавление по id покажет имя и @username сразу
        this.h.run(() => this.h.store.flush());
        return { user: u };
      }
    }
  }
}
