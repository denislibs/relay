import type { Contact, PublicUser, Update } from '@relay/protocol';
import type { Ops, PendingOp } from './ops';
import type { Store } from './store';
import { cleanName, cleanText } from './text';
import type { Action, Item, LocalChat } from './types';

/** Ключ операций контакта в очереди ops: добавление, правка и удаление одного человека схлопываются друг с другом. */
export const OP_CONTACT = 'contact:';
export const contactKey = (userId: number) => OP_CONTACT + userId;
export const contactIdOf = (key: string): number | null => (key.startsWith(OP_CONTACT) ? Number(key.slice(OP_CONTACT.length)) || null : null);

export interface ContactBase { userId: number; firstName: string; lastName: string; note: string; user: PublicUser; presence?: { online: boolean; lastSeen: string | null } }
export interface ContactView extends ContactBase { pending: boolean }
type Presence = { online: boolean; lastSeen: string | null };

export const contactName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();

function baseOf(c: Contact): ContactBase {
  const { seq: _seq, ...rest } = c;
  return rest;
}

/**
 * Контакты: база — последнее, что сказал сервер (GET /contacts, ответ операции, contactsChanged).
 * Источники приходят вразнобой — упорядочивает seq журнала владельца: у каждого контакта свой seq,
 * снимок списка поднимает общий пол (всё, что не новее снимка, уже в нём учтено).
 * Хранится в IDB в meta.contacts и пишется вместе с lastSeq в Store.flush.
 */
export class ContactsCache {
  base = new Map<number, ContactBase>();
  /** снимок с сервера уже был (иначе пустой список — это «ещё не знаем») */
  loaded = false;
  /** изменилось с последнего прохода подписок */
  dirty = false;
  /** растёт при каждом изменении базы (мемо вида) */
  version = 0;
  /** у кого контакт появился/пропал/переименован с последнего прохода: id → запись до изменения */
  private retitles = new Map<number, ContactBase | undefined>();
  private seqs = new Map<number, number>();
  private floor = 0;
  private persist = false;

  static load(meta: { k: string; v: unknown }[]): ContactsCache {
    const c = new ContactsCache();
    const v = meta.find((m) => m.k === 'contacts')?.v as { list: ContactBase[]; seqs: [number, number][]; floor: number; loaded?: boolean } | undefined;
    if (v) {
      for (const x of v.list) c.base.set(x.userId, x);
      c.seqs = new Map(v.seqs);
      c.floor = v.floor;
      c.loaded = v.loaded ?? true;
    }
    return c;
  }

  private seqOf(id: number): number { return Math.max(this.seqs.get(id) ?? 0, this.floor); }
  private touch(): void { this.dirty = true; this.persist = true; this.version++; }
  private before(id: number): void { if (!this.retitles.has(id)) this.retitles.set(id, this.base.get(id)); }

  /** Контакт добавлен/изменён. seq — номер записи журнала (или ответа); не новее известного — не трогаем. */
  applyContact(c: Contact, seq = c.seq): boolean {
    if (seq !== undefined && seq <= this.seqOf(c.userId)) return false;
    this.before(c.userId);
    this.base.set(c.userId, baseOf(c));
    if (seq !== undefined) this.seqs.set(c.userId, seq);
    this.touch();
    return true;
  }

  applyRemoved(userId: number, seq?: number): boolean {
    if (seq !== undefined && seq <= this.seqOf(userId)) return false;
    this.before(userId);
    this.base.delete(userId);
    if (seq !== undefined) this.seqs.set(userId, seq);
    this.touch();
    return true;
  }

  /** Весь список на момент seq: всё, что не новее, заменяется снимком. */
  applySnapshot(list: Contact[], seq: number): void {
    const ids = new Set(list.map((c) => c.userId));
    for (const c of list) if (seq >= this.seqOf(c.userId)) { const prev = this.base.get(c.userId); if (!prev || contactName(prev) !== contactName(c)) this.before(c.userId); this.base.set(c.userId, baseOf(c)); this.seqs.set(c.userId, seq); }
    for (const id of [...this.base.keys()]) if (!ids.has(id) && seq >= this.seqOf(id)) { this.before(id); this.base.delete(id); this.seqs.set(id, seq); }
    this.floor = Math.max(this.floor, seq);
    this.loaded = true;
    this.touch();
  }

  /** Чьи контакты изменились в базе (и какими были до того) — забрать для переименования чатов. */
  takeRetitles(): Map<number, ContactBase | undefined> {
    const r = this.retitles;
    this.retitles = new Map();
    return r;
  }

  /** Что дописать в meta в транзакции flush. */
  collect(): { k: string; v: unknown } | null {
    if (!this.persist) return null;
    this.persist = false;
    return { k: 'contacts', v: { list: [...this.base.values()], seqs: [...this.seqs], floor: this.floor, loaded: this.loaded } };
  }

  /** База сервера пересоздана: всё забыть; «загружено» — только после настоящего GET /contacts. */
  reset(): void {
    this.base.clear();
    this.seqs.clear();
    this.retitles.clear();
    this.floor = 0;
    this.loaded = false;
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
      const user = prev?.user ?? users.get(id) ?? { id, name: '', firstName: '', lastName: '', username: null, bio: null, birthday: null, phone: null };
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
      username: u.username, phone: u.phone, online: p?.online ?? false, lastSeen: p?.lastSeen ?? null, known: !!p, pending: c.pending,
    });
  }
  return out;
}

/** contactsChanged из журнала: база контактов и профиль в кэше (названия чатов — Contacts.retitle на проходе подписок). */
export function applyContactsChanged(store: Store, u: Extract<Update, { type: 'contactsChanged' }>, seq?: number): void {
  if (u.contact) {
    if (store.contacts.applyContact(u.contact, seq)) store.profile.applyUser(u.contact.user);
  } else if (u.removed) {
    if (store.contacts.applyRemoved(u.removed, seq) && u.user) store.profile.applyUser(u.user);
  }
}

/** Как на сервере в listChats: у личного чата нет своего названия — имя собеседника (у владельца — контактное). */
function retitleChats(store: Store, chats: LocalChat[] | undefined, title: string): void {
  for (const c of chats ?? []) if (c.title !== title) { c.title = title; store.markChat(c); }
}

/** Личные чаты по собеседнику. */
function directByPeer(store: Store): Map<number, LocalChat[]> {
  const by = new Map<number, LocalChat[]>();
  for (const c of store.chats.values()) if (c.kind === 'direct' && c.peerId) { const l = by.get(c.peerId); if (l) l.push(c); else by.set(c.peerId, [c]); }
  return by;
}

/** Что движок даёт контактам. */
export interface ContactsHost {
  store: Store;
  ops: Ops;
  httpBase: string;
  headers?: Record<string, string>;
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

/** Контакты в движке: вид (база + очередь), названия личных чатов, операции, снимок с сервера. */
export class Contacts {
  private memo: { version: number; ops: readonly PendingOp[]; view: Map<number, ContactView> } | null = null;
  private shown = new Map<number, string>();
  private shownKey: { version: number; ops: readonly PendingOp[] } | null = null;

  constructor(private h: ContactsHost) {}

  private get cache(): ContactsCache { return this.h.store.contacts; }

  /** База + очередь (мемо до изменения базы или очереди). */
  view(): Map<number, ContactView> {
    const m = this.memo, c = this.cache, ops = this.h.ops.list;
    if (m && m.version === c.version && m.ops === ops) return m.view;
    const view = contactsView(c.base, ops, this.h.store.profile.users);
    this.memo = { version: c.version, ops, view };
    return view;
  }

  /** Название личного чата: контактное (с учётом очереди); контакт удаляется, но сервер ещё не ответил — своё имя человека. */
  titleOf(c: LocalChat): string | null {
    if (c.kind !== 'direct' || !c.peerId) return c.title;
    const v = this.view().get(c.peerId);
    if (v) return contactName(v) || c.title;
    const was = this.cache.base.get(c.peerId);
    if (was) return this.publicName(c.peerId, was) ?? c.title;
    return c.title;
  }

  private publicName(id: number, was?: ContactBase): string | null {
    return this.h.store.profile.users.get(id)?.publicName ?? was?.user.publicName ?? null;
  }

  /** Результат подписки contacts. */
  items(): Item[] {
    const c = this.cache;
    const list = c.loaded || this.h.ops.list.some((o) => contactIdOf(o.key)) ? contactItems(this.view(), this.h.store.profile.users, this.h.presence()) : [];
    // служебный элемент: снимок с сервера уже был (иначе пустой список — «ещё грузим», а не «нет контактов»)
    list.push({ key: '~contacts', loaded: c.loaded });
    return list;
  }

  /**
   * Перед проходом подписок: (1) база изменилась (снимок, журнал, ответ — в любом порядке) — переписать chat.title,
   * как его отдал бы сервер; (2) показанное имя изменилось (в том числе из-за очереди или отказа) — строки чатов пересчитать.
   * Ни база, ни очередь не менялись — ничего не делаем.
   */
  retitle(): void {
    const store = this.h.store;
    const base = this.cache.takeRetitles();
    const by = base.size ? directByPeer(store) : null;
    for (const [id, was] of base) {
      const now = this.cache.base.get(id);
      if (now) { retitleChats(store, by!.get(id), contactName(now) || now.user.name); continue; }
      const pub = this.publicName(id, was);
      if (pub) retitleChats(store, by!.get(id), pub);
      // в кэше профиля могла остаться запись с контактным именем: исправить сразу и перезапросить с сервера
      const u = store.profile.users.get(id);
      if (u && pub && u.name !== pub) {
        const sp = pub.indexOf(' ');
        store.profile.applyUser({ ...u, name: pub, firstName: sp < 0 ? pub : pub.slice(0, sp), lastName: sp < 0 ? '' : pub.slice(sp + 1) });
      }
      this.h.refreshUser(id);
    }
    const key = this.shownKey, version = this.cache.version, ops = this.h.ops.list;
    if (key && key.version === version && key.ops === ops) return;
    this.shownKey = { version, ops };
    const now = new Map<number, string>();
    for (const [id, v] of this.view()) now.set(id, contactName(v));
    const changed = new Set<number>();
    for (const [id, n] of now) if (this.shown.get(id) !== n) changed.add(id);
    for (const id of this.shown.keys()) if (!now.has(id)) changed.add(id);
    this.shown = now;
    if (!changed.size) return;
    for (const c of store.chats.values()) if (c.kind === 'direct' && c.peerId && changed.has(c.peerId)) store.retouch(c.id);
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
      for (const c of r.contacts) if (this.cache.base.has(c.userId)) this.take(c);
      this.retitle();
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
      this.retitle();
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
          res = await fetch(`${this.h.httpBase}/users/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.h.headers ?? {}) }, credentials: 'include', body: JSON.stringify({ query: a.query }) });
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
