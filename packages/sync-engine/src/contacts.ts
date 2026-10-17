import type { Contact, PublicUser, Update } from '@relay/protocol';
import type { PendingOp } from './ops';
import type { Store } from './store';
import type { Item } from './types';

/** Ключ операций контакта в очереди ops: добавление, правка и удаление одного человека схлопываются друг с другом. */
export const OP_CONTACT = 'contact:';
export const contactKey = (userId: number) => OP_CONTACT + userId;
export const contactIdOf = (key: string): number | null => (key.startsWith(OP_CONTACT) ? Number(key.slice(OP_CONTACT.length)) || null : null);

export interface ContactBase { userId: number; firstName: string; lastName: string; note: string; user: PublicUser; presence?: { online: boolean; lastSeen: string | null } }
export interface ContactView extends ContactBase { pending: boolean }

const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ');
const cleanNote = (s: string) => s.replace(/\r\n?/g, '\n').trim();
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
  private seqs = new Map<number, number>();
  private floor = 0;
  private persist = false;

  static load(meta: { k: string; v: unknown }[]): ContactsCache {
    const c = new ContactsCache();
    const v = meta.find((m) => m.k === 'contacts')?.v as { list: ContactBase[]; seqs: [number, number][]; floor: number } | undefined;
    if (v) {
      for (const x of v.list) c.base.set(x.userId, x);
      c.seqs = new Map(v.seqs);
      c.floor = v.floor;
      c.loaded = true;
    }
    return c;
  }

  private seqOf(id: number): number { return Math.max(this.seqs.get(id) ?? 0, this.floor); }
  private touch(): void { this.dirty = true; this.persist = true; this.version++; }

  /** Контакт добавлен/изменён. seq — номер записи журнала (или ответа); не новее известного — не трогаем. */
  applyContact(c: Contact, seq = c.seq): boolean {
    if (seq !== undefined && seq <= this.seqOf(c.userId)) return false;
    this.base.set(c.userId, baseOf(c));
    if (seq !== undefined) this.seqs.set(c.userId, seq);
    this.touch();
    return true;
  }

  applyRemoved(userId: number, seq?: number): boolean {
    if (seq !== undefined && seq <= this.seqOf(userId)) return false;
    this.base.delete(userId);
    if (seq !== undefined) this.seqs.set(userId, seq);
    this.touch();
    return true;
  }

  /** Весь список на момент seq: всё, что не новее, заменяется снимком. */
  applySnapshot(list: Contact[], seq: number): void {
    const ids = new Set(list.map((c) => c.userId));
    for (const c of list) if (seq >= this.seqOf(c.userId)) { this.base.set(c.userId, baseOf(c)); this.seqs.set(c.userId, seq); }
    for (const id of [...this.base.keys()]) if (!ids.has(id) && seq >= this.seqOf(id)) { this.base.delete(id); this.seqs.set(id, seq); }
    this.floor = Math.max(this.floor, seq);
    this.loaded = true;
    this.touch();
  }

  /** Что дописать в meta в транзакции flush. */
  collect(): { k: string; v: unknown } | null {
    if (!this.persist) return null;
    this.persist = false;
    return { k: 'contacts', v: { list: [...this.base.values()], seqs: [...this.seqs], floor: this.floor } };
  }

  reset(): void {
    this.base.clear();
    this.seqs.clear();
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
        note: b.note !== undefined ? cleanNote(b.note) : prev?.note ?? '', user, presence: prev?.presence, pending: true,
      });
    } else if (op.method === 'PATCH' && prev) {
      view.set(id, {
        ...prev,
        firstName: b.firstName !== undefined ? cleanName(b.firstName) : prev.firstName,
        lastName: b.lastName !== undefined ? cleanName(b.lastName ?? '') : prev.lastName,
        note: b.note !== undefined ? cleanNote(b.note ?? '') : prev.note,
        pending: true,
      });
    }
  }
  return view;
}

/** Собственное имя человека (без контактного): из профиля, иначе — то, что было до контакта. */
export const publicNameOf = (u: PublicUser | undefined): string | null => u?.publicName ?? null;

/** Элементы подписки contacts: контакт + профиль + присутствие (живое — из движка, иначе из ответа сервера). */
export function contactItems(view: Map<number, ContactView>, users: ReadonlyMap<number, PublicUser>, presence: ReadonlyMap<number, { online: boolean; lastSeen: string | null }>): Item[] {
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

/** contactsChanged из журнала: база контактов, профиль в кэше и название личного чата с этим человеком. */
export function applyContactsChanged(store: Store, u: Extract<Update, { type: 'contactsChanged' }>, seq?: number): void {
  if (u.contact) {
    if (!store.contacts.applyContact(u.contact, seq)) return;
    retitle(store, u.contact.userId, contactName(u.contact) || u.contact.user.name);
    store.profile.applyUser(u.contact.user);
  } else if (u.removed) {
    if (!store.contacts.applyRemoved(u.removed, seq) || !u.user) return;
    retitle(store, u.removed, u.user.name);
    store.profile.applyUser(u.user);
  }
}

/** Как на сервере в listChats: у личного чата нет своего названия — имя собеседника (у владельца — контактное). */
export function retitle(store: Store, peerId: number, title: string): void {
  for (const c of store.chats.values()) {
    if (c.kind === 'direct' && c.peerId === peerId && c.title !== title) { c.title = title; store.markChat(c); }
  }
}
