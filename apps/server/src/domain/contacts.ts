import type { BlockedUser, Contact, PublicUser } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';
import { announcePair, presenceFor, type PairChange, type Publish } from './presence';
import { canFindByPhone, privacyCtx, type PrivacyCtx } from './privacy';
import { canView, COLS, publicUser, publicUserFor, republishUser, selfSeq, validName, validText, type ContactName, type Row } from './profile';

const NOTE_MAX = 128;

/** Запрос «@имя» / «имя» / телефон → что искать. Телефон: без пробелов, дефисов и скобок, 8XXXXXXXXXX → +7…, обязателен «+». */
export function parseQuery(raw: unknown): { username: string } | { phone: string } | null {
  if (typeof raw !== 'string') return null;
  const q = raw.trim();
  if (!q) return null;
  if (/^[+\d\s()\-]+$/.test(q) && /\d/.test(q)) {
    let p = q.replace(/[\s()\-]/g, '');
    if (/^8\d{10}$/.test(p)) p = '+7' + p.slice(1);
    return /^\+\d{7,15}$/.test(p) ? { phone: p } : null;
  }
  const u = q.replace(/^@/, '').toLowerCase();
  return /^[a-z][a-z0-9_]{4,31}$/.test(u) ? { username: u } : null;
}

type ContactRow = ContactName & { note: string };

function contactOf(owner: number, r: Row, c: ContactRow, lastSeen: Date | null, ctx: PrivacyCtx, seq?: number): Contact {
  const p = presenceFor(owner, r.id, lastSeen, ctx);
  return {
    userId: r.id, firstName: c.first_name, lastName: c.last_name, note: c.note,
    user: publicUser(owner, r, c, ctx),
    presence: { online: p.online, lastSeen: p.lastSeen },
    ...(seq !== undefined ? { seq } : {}),
  };
}

async function contactRow(db: Tx | typeof sql, owner: number, userId: number): Promise<ContactRow | null> {
  const [c] = await db<ContactRow[]>`select first_name, last_name, note from contacts where owner_id = ${owner} and user_id = ${userId}`;
  return c ?? null;
}

/** Найти человека по @имени или номеру. Себя не находим; номер — только если его правило это разрешает. */
export async function resolveUser(viewer: number, raw: unknown): Promise<PublicUser> {
  const q = parseQuery(raw);
  if (!q) throw new DomainError('not_found');
  const [r] = 'username' in q
    ? await sql<Row[]>`select ${COLS} from users where lower(username) = ${q.username}`
    : await sql<Row[]>`select ${COLS} from users where phone = ${q.phone}`;
  if (!r || r.id === viewer) throw new DomainError('not_found');
  const ctx = await privacyCtx(sql, [[viewer, r.id]]);
  if ('phone' in q && !canFindByPhone(viewer, r.id, ctx)) throw new DomainError('not_found');
  return publicUser(viewer, r, await contactRow(sql, viewer, r.id), ctx);
}

/** Контакты владельца с присутствием (снимок на seq его журнала). */
export async function listContacts(owner: number): Promise<{ contacts: Contact[]; seq: number }> {
  return sql.begin(async (tx) => {
    await tx`set transaction isolation level repeatable read`;
    const rows = await tx`
      select ${sql`u.id, u.name, u.first_name, u.last_name, u.username, u.bio, u.birthday, u.phone, u.links`}, u.last_seen_at,
             c.first_name as c_first, c.last_name as c_last, c.note as c_note
        from contacts c join users u on u.id = c.user_id
       where c.owner_id = ${owner}
       order by c.created_at, c.user_id`;
    const ctx = await privacyCtx(tx, rows.map((r) => [owner, Number(r.id)]));
    const contacts = rows.map((r) => contactOf(owner, r as unknown as Row, { first_name: r.c_first, last_name: r.c_last, note: r.c_note }, r.last_seen_at as Date | null, ctx));
    return { contacts, seq: await selfSeq(tx, owner) };
  }) as Promise<{ contacts: Contact[]; seq: number }>;
}

const validNote = (v: unknown) => validText(v, NOTE_MAX, 'note_too_long');

/** Контекст пары до правки связи owner → userId (контакт, блокировка); обе стороны. */
const pairCtx = (db: Tx | typeof sql, owner: number, userId: number) => privacyCtx(db, [[userId, owner]]);

/**
 * Связь owner → userId изменилась (добавил/удалил контакт, заблокировал/разблокировал): от неё зависит, что userId
 * видит у owner (правила «Мои контакты», блокировка). В той же транзакции — корректирующий userUpdated ему,
 * если он вообще видит owner; присутствие — после коммита (announcePair), только если вид поменялся.
 */
async function relinked(tx: Tx, owner: number, userId: number, before: PrivacyCtx): Promise<PairChange> {
  const after = await pairCtx(tx, owner, userId);
  if (await canView(tx, userId, owner)) await republishUser(tx, owner, [userId], before, after);
  return { a: owner, b: userId, before, after };
}
const afterCommit = async (publish: Publish | undefined, change: PairChange | null) => {
  if (publish && change) await announcePair(publish, change).catch((e) => console.error('presence:', e));
};

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Записать контакт и contactsChanged владельцу — одной транзакцией; ответ — то же, что в журнале, плюс seq. */
async function write(tx: Tx, owner: number, userId: number): Promise<Contact> {
  const [r] = await tx`select ${COLS}, last_seen_at from users where id = ${userId}`;
  const c = (await contactRow(tx, owner, userId))!;
  const contact = contactOf(owner, r as unknown as Row, c, r.last_seen_at as Date | null, await privacyCtx(tx, [[owner, userId]]));
  await appendUpdates(tx, [{ userId: owner, update: { type: 'contactsChanged', contact } }]);
  return { ...contact, seq: await selfSeq(tx, owner) };
}

/** Добавить (или переименовать, если уже есть) контакт по userId или по запросу (@имя, телефон). */
export async function addContact(owner: number, body: unknown, publish?: Publish): Promise<Contact> {
  if (!plain(body)) throw new DomainError('bad_frame');
  const first = validName(body.firstName, 1);
  const last = validName(body.lastName ?? '', 0);
  const note = body.note !== undefined ? validNote(body.note) : undefined;
  let userId: number;
  if (body.userId !== undefined) {
    if (typeof body.userId !== 'number' || !Number.isSafeInteger(body.userId) || body.userId <= 0) throw new DomainError('bad_frame');
    userId = body.userId;
    // по id — только тех, кого и так видно (общий чат, контакт): иначе перебором id можно узнать всех
    if (userId === owner || !(await canView(sql, owner, userId))) throw new DomainError('not_found');
  } else {
    userId = (await resolveUser(owner, body.query)).id;
  }
  let change: PairChange | null = null;
  const res = await sql.begin(async (tx) => {
    const before = await pairCtx(tx, owner, userId);
    const ins = await tx`insert into contacts (owner_id, user_id, first_name, last_name, note)
             values (${owner}, ${userId}, ${first}, ${last}, ${note ?? ''})
             on conflict (owner_id, user_id) do update set first_name = excluded.first_name, last_name = excluded.last_name
               ${note !== undefined ? sql`, note = excluded.note` : sql``}
             returning (xmax = 0) as created`;
    if (ins[0]?.created) change = await relinked(tx, owner, userId, before);   // новый контакт — «Мои контакты» у него теперь про него
    return write(tx, owner, userId);
  }) as Contact;
  await afterCommit(publish, change);
  return res;
}

export async function updateContact(owner: number, userId: number, patch: unknown): Promise<Contact> {
  if (!plain(patch)) throw new DomainError('bad_frame');
  const first = 'firstName' in patch ? validName(patch.firstName, 1) : undefined;
  const last = 'lastName' in patch ? validName(patch.lastName ?? '', 0) : undefined;
  const note = 'note' in patch ? validNote(patch.note ?? '') : undefined;
  return sql.begin(async (tx) => {
    const [cur] = await tx<ContactRow[]>`select first_name, last_name, note from contacts where owner_id = ${owner} and user_id = ${userId} for update`;
    if (!cur) throw new DomainError('not_found');
    await tx`update contacts set first_name = ${first ?? cur.first_name}, last_name = ${last ?? cur.last_name}, note = ${note ?? cur.note}
             where owner_id = ${owner} and user_id = ${userId}`;
    return write(tx, owner, userId);
  }) as Promise<Contact>;
}

/** Удалить контакт (повторное удаление — не ошибка). В журнал — removed и профиль уже без контактного имени. */
export async function removeContact(owner: number, userId: number, publish?: Publish): Promise<{ removed: number; user: PublicUser | null; seq: number }> {
  let change: PairChange | null = null;
  const res = await sql.begin(async (tx) => {
    const before = await pairCtx(tx, owner, userId);
    const del = await tx`delete from contacts where owner_id = ${owner} and user_id = ${userId} returning user_id`;
    if (del.length) change = await relinked(tx, owner, userId, before);
    const [r] = await tx<Row[]>`select ${COLS} from users where id = ${userId}`;
    const user = r && (await canView(tx, owner, userId)) ? await publicUserFor(tx, owner, r, null) : null;
    if (del.length) await appendUpdates(tx, [{ userId: owner, update: { type: 'contactsChanged', removed: userId, user } }]);
    return { removed: userId, user, seq: await selfSeq(tx, owner) };
  }) as { removed: number; user: PublicUser | null; seq: number };
  await afterCommit(publish, change);
  return res;
}

// ---------- чёрный список ----------

type BlockRow = Row & { created_at: Date; c_first: string | null; c_last: string | null };
const blockCols = sql`u.id, u.name, u.first_name, u.last_name, u.username, u.bio, u.birthday, u.phone, u.links, b.created_at, c.first_name as c_first, c.last_name as c_last`;

function blockedOf(owner: number, r: BlockRow, ctx: PrivacyCtx): BlockedUser {
  const c = r.c_first !== null ? { first_name: r.c_first, last_name: r.c_last ?? '' } : null;
  return { userId: r.id, user: publicUser(owner, r, c, ctx), at: new Date(r.created_at).toISOString() };
}

async function blockedRow(db: Tx | typeof sql, owner: number, userId: number): Promise<BlockRow | null> {
  const [r] = await db<BlockRow[]>`
    select ${blockCols} from blocks b join users u on u.id = b.user_id
      left join contacts c on c.owner_id = b.owner_id and c.user_id = b.user_id
     where b.owner_id = ${owner} and b.user_id = ${userId}`;
  return r ?? null;
}

/** Заблокированные владельцем, новые сверху (снимок на seq его журнала). */
export async function listBlocked(owner: number): Promise<{ blocked: BlockedUser[]; seq: number }> {
  return sql.begin(async (tx) => {
    await tx`set transaction isolation level repeatable read`;
    const rows = await tx<BlockRow[]>`
      select ${blockCols} from blocks b join users u on u.id = b.user_id
        left join contacts c on c.owner_id = b.owner_id and c.user_id = b.user_id
       where b.owner_id = ${owner}
       order by b.created_at desc, b.user_id desc`;
    const ctx = await privacyCtx(tx, rows.map((r) => [owner, r.id]));
    return { blocked: rows.map((r) => blockedOf(owner, r, ctx)), seq: await selfSeq(tx, owner) };
  }) as Promise<{ blocked: BlockedUser[]; seq: number }>;
}

/**
 * Заблокировать (повтор — не ошибка). Одной транзакцией: строка, blocksChanged владельцу и корректирующий
 * userUpdated заблокированному (о себе, дне рождения и номере он больше не узнает). Присутствие — после коммита.
 */
export async function blockUser(owner: number, userId: number, publish?: Publish): Promise<BlockedUser> {
  // блокировать можно только тех, кого и так видно (общий чат, контакт): иначе перебором id можно узнать всех
  if (userId === owner || !(await canView(sql, owner, userId))) throw new DomainError('not_found');
  let change: PairChange | null = null;
  const res = await sql.begin(async (tx) => {
    const before = await pairCtx(tx, owner, userId);
    const ins = await tx`insert into blocks (owner_id, user_id) values (${owner}, ${userId}) on conflict do nothing returning user_id`;
    const r = (await blockedRow(tx, owner, userId))!;
    const item = blockedOf(owner, r, await privacyCtx(tx, [[owner, userId]]));
    if (ins.length) {
      await appendUpdates(tx, [{ userId: owner, update: { type: 'blocksChanged', blocked: item } }]);
      change = await relinked(tx, owner, userId, before);   // у него blocksMe: true, скрытые поля пропадают
    }
    return { ...item, seq: await selfSeq(tx, owner) };
  }) as BlockedUser;
  await afterCommit(publish, change);
  return res;
}

/** Разблокировать (повтор — не ошибка): blocksChanged владельцу, разблокированному — профиль снова целиком. */
export async function unblockUser(owner: number, userId: number, publish?: Publish): Promise<{ unblocked: number; seq: number }> {
  let change: PairChange | null = null;
  const res = await sql.begin(async (tx) => {
    const before = await pairCtx(tx, owner, userId);
    const del = await tx`delete from blocks where owner_id = ${owner} and user_id = ${userId} returning user_id`;
    if (del.length) {
      await appendUpdates(tx, [{ userId: owner, update: { type: 'blocksChanged', unblocked: userId } }]);
      change = await relinked(tx, owner, userId, before);   // blocksMe: false — плашка у него снимается
    }
    return { unblocked: userId, seq: await selfSeq(tx, owner) };
  }) as { unblocked: number; seq: number };
  await afterCommit(publish, change);
  return res;
}
