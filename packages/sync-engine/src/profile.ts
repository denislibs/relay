import type { Birthday, Me, ProfileLink, ProfilePhoto, PublicUser } from '@relay/protocol';
import { getAll } from './idb';
import { cleanName, cleanText } from './text';
import type { PendingOp } from './ops';
import type { Store } from './store';
import { Table } from './rows';
import type { Item } from './types';

/** Ключи операций профиля в очереди ops. */
export const OP_PROFILE = 'profile';
export const OP_USERNAME = 'username';
/** ссылки — отдельной операцией: список целиком, новая правка заменяет неотправленную, не трогая правку имени */
export const OP_LINKS = 'links';

export interface ProfilePatch { firstName?: string; lastName?: string; bio?: string | null; birthday?: Birthday | null }

/**
 * Профили: свой (база — последнее, что сказал сервер: GET /me, ответ операции, userUpdated себе)
 * и кэш чужих (PublicUser по id: userUpdated, GET /users/:id). Хранятся в IDB (meta.me, users),
 * пишутся вместе с lastSeq в Store.flush.
 */
export class ProfileCache {
  me: Me | null = null;
  /** чужие профили; seq строки — номер записи журнала, с которой пришёл профиль: снимок или ответ старее не перетирает */
  readonly users = new Table<number, PublicUser>();
  /** изменилось с последнего прохода подписок */
  dirty = false;
  /** растёт при каждой смене базы me: ответ GET /me, начатого раньше, уже устарел */
  gen = 0;
  private dirtyMe = false;

  constructor(readonly userId: number) {}

  static async load(db: IDBDatabase, userId: number, meta: { k: string; v: unknown }[]): Promise<ProfileCache> {
    const p = new ProfileCache(userId);
    p.me = (meta.find((m) => m.k === 'me')?.v as Me | undefined) ?? null;
    p.users.load(await getAll<PublicUser & { seq: number }>(db, 'users'), (u) => u.id);
    return p;
  }

  /**
   * Новая база своего профиля. Источники — ответ операции, GET /me, запись журнала — приходят вразнобой;
   * упорядочивает их seq (номер своей записи журнала, на момент которой снят профиль): старое не откатывает новое.
   */
  setMe(me: Me): boolean {
    const cur = this.me?.seq;
    if (me.seq !== undefined && cur !== undefined && me.seq < cur) return false;
    // то же самое с тем же или более новым seq: запоминаем seq, подписки не трогаем
    if (this.me && JSON.stringify({ ...this.me, seq: undefined }) === JSON.stringify({ ...me, seq: undefined })) {
      if (me.seq !== undefined && me.seq !== cur) { this.me = me; this.dirtyMe = true; }
      return false;
    }
    this.me = me;
    this.gen++;
    this.dirtyMe = true;
    this.dirty = true;
    return true;
  }

  /** Профиль из журнала или с сервера. Свой — новая база me (телефон из PublicUser себе виден). */
  applyUser(u: PublicUser, seq?: number): void {
    if (u.id === this.userId) {
      // запись журнала не новее уже применённого ответа (своя же правка, эхо) — не откатываем
      if (seq !== undefined && this.me?.seq !== undefined && seq <= this.me.seq) return;
      this.setMe({ userId: u.id, name: u.name, firstName: u.firstName, lastName: u.lastName, username: u.username, bio: u.bio, birthday: u.birthday, links: u.links ?? [], photo: u.photo ?? null, phone: u.phone ?? this.me?.phone ?? null, seq: seq ?? this.me?.seq });
      return;
    }
    // без seq (GET /users/:id) — как раньше, поверх известного; с seq — старее сохранённого не принимается
    const prev = this.users.get(u.id);
    if (this.users.put(u.id, u, seq ?? prev?.seq ?? 0)) this.dirty = true;
  }

  /**
   * Собеседник из снимка списка чатов (id, имя, фото) — поверх известного профиля. У снимка нет seq по человеку:
   * пишем с seq 0, так что профиль из журнала (seq > 0) снимок не перетирает.
   */
  applyPeer(p: { id: number; name: string; system?: true; photo?: ProfilePhoto | null }): void {
    if (p.id === this.userId) return;
    const prev = this.users.get(p.id);
    let base: PublicUser;
    if (prev) { const { seq: _s, v: _v, ...rest } = prev; base = rest; }
    else { const sp = p.name.indexOf(' '); base = { id: p.id, name: p.name, firstName: sp < 0 ? p.name : p.name.slice(0, sp), lastName: sp < 0 ? '' : p.name.slice(sp + 1), username: null, bio: null, birthday: null, phone: null, links: [] }; }
    const next: PublicUser = { ...base, name: p.name, photo: p.photo ?? null };
    if (p.system) next.system = true;
    if (this.users.put(p.id, next, 0)) this.dirty = true;
  }

  /** Что дописать в транзакцию flush. */
  collect(): { me: { k: string; v: unknown } | null; users: unknown[]; del: number[] } {
    const { put, del } = this.users.collect();
    const out = { me: this.dirtyMe && this.me ? { k: 'me', v: this.me } : null, users: put, del };
    this.dirtyMe = false;
    return out;
  }

  reset(): void {
    this.me = null;
    this.users.clear();
    this.dirtyMe = false;
    this.gen++;
    this.dirty = true;
  }
}

/** userUpdated: кэш профилей. Строки личных чатов с этим человеком пересчитает PeerSigs (names.ts) — сами чаты не трогаем. */
export function applyUserUpdated(store: Store, u: PublicUser, seq?: number): void {
  store.profile.applyUser(u, seq);
}

const cleanBio = (s: string | null) => (s == null ? null : cleanText(s) || null);
export const cleanUsername = (s: string | null) => (s ? s.trim().replace(/^@/, '').toLowerCase() || null : null);

/** Свой профиль, как его видит интерфейс: база сервера + ещё не подтверждённые правки из очереди (по порядку). */
export function meView(base: Me | null, ops: readonly PendingOp[]): Me | null {
  if (!base) return null;
  let me = base;
  for (const op of ops) {
    if (op.key === OP_PROFILE) {
      const b = (op.body ?? {}) as ProfilePatch;
      me = { ...me };
      if (b.firstName !== undefined) me.firstName = cleanName(b.firstName);
      if (b.lastName !== undefined) me.lastName = cleanName(b.lastName ?? '');
      if (b.bio !== undefined) me.bio = cleanBio(b.bio);
      if (b.birthday !== undefined) me.birthday = b.birthday;
      me.name = `${me.firstName} ${me.lastName}`.trim();
    } else if (op.key === OP_LINKS) {
      me = { ...me, links: (op.body as { links: ProfileLink[] }).links };
    } else if (op.key === OP_USERNAME) {
      me = { ...me, username: cleanUsername((op.body as { username: string | null }).username) };
    }
  }
  return me;
}

/** Элемент подписки me. */
export function meItem(me: Me | null): Item[] {
  if (!me) return [];
  const { seq: _seq, ...rest } = me;
  return [{ key: 'me', ...rest }];
}

/** Элемент подписки user: свой — из meView (с оптимистичными правками), чужой — из кэша. */
export function userItem(p: ProfileCache, me: Me | null, userId: number): Item[] {
  if (userId === p.userId) {
    return me ? [{ key: 'u' + userId, id: me.userId, name: me.name, firstName: me.firstName, lastName: me.lastName, username: me.username, bio: me.bio, birthday: me.birthday, phone: me.phone, links: me.links ?? [] }] : [];
  }
  const u = p.users.get(userId);
  if (!u) return [];
  const { seq: _seq, v: _v, ...rest } = u;
  return [{ key: 'u' + userId, ...rest }];
}
