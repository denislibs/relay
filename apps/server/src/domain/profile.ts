import type { Birthday, Me, PublicUser } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';

const RESERVED = new Set(['admin', 'relay', 'support', 'settings', 'help', 'api', 'root', 'system', 'null', 'undefined', 'me']);
const USERNAME = /^[a-z][a-z0-9_]{4,31}$/;
const len = (s: string) => [...s].length;

export type Row = { id: number; name: string; first_name: string | null; last_name: string | null; username: string | null; bio: string | null; birthday: Birthday | null; phone: string | null };
export const COLS = sql`id, name, first_name, last_name, username, bio, birthday, phone`;

export const fullName = (first: string, last: string) => `${first} ${last}`.trim();

/** Пользователи, созданные без раздельных полей (вход по имени), делятся по первому пробелу — как миграция. */
function parts(r: Row): [string, string] {
  if (r.first_name !== null) return [r.first_name, r.last_name ?? ''];
  const i = r.name.indexOf(' ');
  return i < 0 ? [r.name, ''] : [r.name.slice(0, i), r.name.slice(i + 1).trim()];
}

function shape(r: Row) {
  const [firstName, lastName] = parts(r);
  return {
    name: r.name, firstName, lastName,
    username: r.username, bio: r.bio, birthday: r.birthday, phone: r.phone,
  };
}

/** Последний номер своего журнала: профиль «на момент seq» (см. Me.seq). */
export async function selfSeq(tx: Tx | typeof sql, userId: number): Promise<number> {
  const [s] = await tx`select seq from user_seq where user_id = ${userId}`;
  return s ? Number(s.seq) : 0;
}

export async function getMe(userId: number): Promise<Me> {
  return sql.begin(async (tx) => {
    // одна транзакция: профиль и seq — из одного снимка (repeatable read)
    await tx`set transaction isolation level repeatable read`;
    const [r] = await tx<Row[]>`select ${COLS} from users where id = ${userId}`;
    if (!r) throw new DomainError('not_found');
    return { userId: r.id, ...shape(r), seq: await selfSeq(tx, userId) };
  }) as Promise<Me>;
}

/** Единственная точка правил приватности: B6 подставит сюда настоящую проверку (телефон, био, день рождения…). */
export function canSee(viewer: number, owner: number, field: 'phone' | 'username' | 'bio' | 'birthday'): boolean {
  return field !== 'phone' || viewer === owner; // телефон — только себе, пока нет правил B6
}

/** Правило «Кто найдёт меня по номеру» (B6): пока находят все. */
export function canFindByPhone(_viewer: number, _owner: number): boolean {
  return true;
}

/** Имя, которое владелец дал контакту. */
export type ContactName = { first_name: string; last_name: string };

/**
 * Представление пользователя для конкретного зрителя. Всё, что уходит наружу (HTTP, журнал), идёт через эту функцию.
 * contact — запись зрителя об этом человеке: имя у зрителя — контактное (видно только ему), своё — в publicName.
 */
export function publicUser(viewer: number, r: Row, contact?: ContactName | null): PublicUser {
  const s = shape(r);
  const c = contact && r.id !== viewer ? contact : null;
  return {
    id: r.id, name: c ? fullName(c.first_name, c.last_name) : s.name,
    firstName: c ? c.first_name : s.firstName, lastName: c ? c.last_name : s.lastName, publicName: s.name,
    username: canSee(viewer, r.id, 'username') ? s.username : null,
    bio: canSee(viewer, r.id, 'bio') ? s.bio : null,
    birthday: canSee(viewer, r.id, 'birthday') ? s.birthday : null,
    phone: canSee(viewer, r.id, 'phone') ? s.phone : null,
  };
}

/** Кто видит пользователя: все, с кем есть общий чат (личный или группа), и те, у кого он в контактах. */
export async function viewersOf(tx: Tx | typeof sql, userId: number): Promise<number[]> {
  const rows = await tx`
    select b.user_id from chat_members a join chat_members b on b.chat_id = a.chat_id
     where a.user_id = ${userId} and b.user_id <> ${userId}
    union
    select owner_id from contacts where user_id = ${userId}`;
  return rows.map((r) => Number(r.user_id));
}

/** Контактные имена этого человека у зрителей (зритель → имя). */
export async function contactNames(tx: Tx | typeof sql, userId: number, viewers: number[]): Promise<Map<number, ContactName>> {
  if (!viewers.length) return new Map();
  const rows = await tx`select owner_id, first_name, last_name from contacts where user_id = ${userId} and owner_id = any(${viewers}::bigint[])`;
  return new Map(rows.map((r) => [Number(r.owner_id), { first_name: r.first_name as string, last_name: r.last_name as string }]));
}

/** Может ли зритель смотреть профиль: общий чат или контакт в любую сторону. */
export async function canView(db: Tx | typeof sql, viewer: number, id: number): Promise<boolean> {
  if (id === viewer) return true;
  const [r] = await db`select (
      exists (select 1 from chat_members a join chat_members b on b.chat_id = a.chat_id where a.user_id = ${id} and b.user_id = ${viewer})
      or exists (select 1 from contacts where (owner_id = ${viewer} and user_id = ${id}) or (owner_id = ${id} and user_id = ${viewer}))
    ) as ok`;
  return !!r.ok;
}

/** Профиль другого пользователя; без общего чата и контакта — 404 (найти по @имени/номеру — /users/resolve). */
export async function getUser(viewer: number, id: number): Promise<PublicUser> {
  const [r] = await sql<Row[]>`select ${COLS} from users where id = ${id}`;
  if (!r || !(await canView(sql, viewer, id))) throw new DomainError('not_found');
  return publicUser(viewer, r, (await contactNames(sql, id, [viewer])).get(viewer));
}

// ---------- валидация ----------

// C0/C1, bidi-переопределения и изоляты, U+200B, BOM. ZWJ/ZWNJ оставляем: на них держатся составные эмодзи и персидский.
const BAD_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069\u200B\uFEFF]/u;

export function validName(v: unknown, min: number): string {
  if (typeof v !== 'string') throw new DomainError('bad_frame');
  const s = v.trim().replace(/\s+/g, ' ');
  if (len(s) < min || len(s) > 64 || BAD_CHARS.test(s)) throw new DomainError('name_invalid');
  return s;
}

function validBio(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new DomainError('bad_frame');
  const s = v.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n]|[\u202A-\u202E\u2066-\u2069\u200B\uFEFF]/gu, '').trim();
  if (len(s) > 140) throw new DomainError('bio_too_long');
  return s || null;
}

export function validBirthday(v: unknown): Birthday | null {
  if (v === null) return null;
  const bad = () => new DomainError('birthday_invalid');
  if (!v || typeof v !== 'object') throw bad();
  const { day, month, year } = v as Record<string, unknown>;
  const int = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
  if (!int(day) || !int(month) || month < 1 || month > 12 || day < 1) throw bad();
  const now = new Date();
  if (year !== undefined && year !== null) {
    if (!int(year) || year < 1900 || year > now.getUTCFullYear()) throw bad();
    if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw bad();
    if (Date.UTC(year, month - 1, day) > now.getTime() + 86_400_000) throw bad();
    return { day, month, year };
  }
  if (day > new Date(Date.UTC(2000, month, 0)).getUTCDate()) throw bad(); // без года 29 февраля допустимо
  return { day, month };
}

export type UsernameCheck = { ok: true } | { ok: false; reason: 'invalid' | 'taken' | 'reserved' };

function usernameShape(raw: unknown): { name: string } | { reason: 'invalid' | 'reserved' } {
  if (typeof raw !== 'string') return { reason: 'invalid' };
  const name = raw.trim().replace(/^@/, '').toLowerCase();
  if (!USERNAME.test(name) || name.endsWith('_') || name.includes('__')) return { reason: 'invalid' };
  if (RESERVED.has(name)) return { reason: 'reserved' };
  return { name };
}

export async function checkUsername(userId: number, raw: unknown): Promise<UsernameCheck> {
  const s = usernameShape(raw);
  if ('reason' in s) return { ok: false, reason: s.reason };
  const [row] = await sql`select id from users where lower(username) = ${s.name}`;
  return row && row.id !== userId ? { ok: false, reason: 'taken' } : { ok: true };
}

// ---------- запись + журнал ----------

/** Применить изменение профиля и записать userUpdated себе и зрителям — одной транзакцией. */
async function save(userId: number, change: (tx: Tx, cur: Row) => Promise<void>): Promise<Me> {
  return sql.begin(async (tx) => {
    const [cur] = await tx<Row[]>`select ${COLS} from users where id = ${userId} for no key update`;
    if (!cur) throw new DomainError('not_found');
    await change(tx, cur);
    const [r] = await tx<Row[]>`select ${COLS} from users where id = ${userId}`;
    if (JSON.stringify(cur) === JSON.stringify(r)) return { userId: r.id, ...shape(r), seq: await selfSeq(tx, userId) }; // ничего не изменилось — журнал не трогаем
    const viewers = await viewersOf(tx, userId);
    const names = await contactNames(tx, userId, viewers);
    // каждому — своё представление (B6: скрытые поля; владельцу контакта — его имя для этого человека)
    await appendUpdates(tx, [userId, ...viewers].map((v) => ({ userId: v, update: { type: 'userUpdated' as const, user: publicUser(v, r, names.get(v)) } })));
    return { userId: r.id, ...shape(r), seq: await selfSeq(tx, userId) };   // seq своей записи userUpdated (строка user_seq под замком транзакции)
  }) as Promise<Me>;
}

export async function updateProfile(userId: number, patch: unknown): Promise<Me> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new DomainError('bad_frame');
  const p = patch as Record<string, unknown>;
  const first = 'firstName' in p ? validName(p.firstName, 1) : undefined;
  const last = 'lastName' in p ? validName(p.lastName ?? '', 0) : undefined;
  const bio = 'bio' in p ? validBio(p.bio) : undefined;
  const birthday = 'birthday' in p ? validBirthday(p.birthday) : undefined;
  return save(userId, async (tx, cur) => {
    const [pf, pl] = parts(cur);
    const f = first ?? pf;
    const l = last ?? pl;
    const name = fullName(f, l);
    const b = birthday === undefined ? cur.birthday : birthday;
    await tx`update users set first_name = ${f}, last_name = ${l || null}, name = ${name},
               bio = ${bio === undefined ? cur.bio : bio},
               birthday = ${b === null ? null : tx.json(b as never)}
             where id = ${userId}`;
  });
}

export async function setUsername(userId: number, raw: unknown): Promise<Me> {
  let name: string | null = null;
  if (raw !== null) {
    const s = usernameShape(raw);
    if ('reason' in s) throw new DomainError(s.reason === 'reserved' ? 'username_reserved' : 'username_invalid');
    name = s.name;
  }
  try {
    return await save(userId, async (tx) => { await tx`update users set username = ${name} where id = ${userId}`; });
  } catch (e) {
    // гонку решает уникальный индекс, а не проверка «до»
    if ((e as { code?: string }).code === '23505') throw new DomainError('username_taken');
    throw e;
  }
}
