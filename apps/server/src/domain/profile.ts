import type { Birthday, Me, PublicUser } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';

const RESERVED = new Set(['admin', 'relay', 'support', 'settings', 'help', 'api', 'root', 'system', 'null', 'undefined', 'me']);
const USERNAME = /^[a-z][a-z0-9_]{4,31}$/;
const len = (s: string) => [...s].length;

type Row = { id: number; name: string; first_name: string | null; last_name: string | null; username: string | null; bio: string | null; birthday: Birthday | null; phone: string | null };
const COLS = sql`id, name, first_name, last_name, username, bio, birthday, phone`;

const fullName = (first: string, last: string) => `${first} ${last}`.trim();

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

export async function getMe(userId: number): Promise<Me> {
  const [r] = await sql<Row[]>`select ${COLS} from users where id = ${userId}`;
  if (!r) throw new DomainError('not_found');
  return { userId: r.id, ...shape(r) };
}

/** Единственная точка правил приватности: B6 подставит сюда настоящую проверку (телефон, био, день рождения…). */
function canSee(viewer: number, owner: number, field: 'phone' | 'username' | 'bio' | 'birthday'): boolean {
  return field !== 'phone' || viewer === owner; // телефон — только себе, пока нет правил B6
}

/** Представление пользователя для конкретного зрителя. Всё, что уходит наружу (HTTP, журнал), идёт через эту функцию. */
export function publicUser(viewer: number, r: Row): PublicUser {
  const s = shape(r);
  return {
    id: r.id, name: s.name, firstName: s.firstName, lastName: s.lastName,
    username: canSee(viewer, r.id, 'username') ? s.username : null,
    bio: canSee(viewer, r.id, 'bio') ? s.bio : null,
    birthday: canSee(viewer, r.id, 'birthday') ? s.birthday : null,
    phone: canSee(viewer, r.id, 'phone') ? s.phone : null,
  };
}

/** Кто видит пользователя: все, с кем есть общий чат (личный или группа). B3 добавит контакты. */
export async function viewersOf(tx: Tx | typeof sql, userId: number): Promise<number[]> {
  const rows = await tx`
    select distinct b.user_id from chat_members a join chat_members b on b.chat_id = a.chat_id
     where a.user_id = ${userId} and b.user_id <> ${userId}`;
  return rows.map((r) => r.user_id as number);
}

/** Профиль другого пользователя; без общего чата — 404 (B3 ослабит для контактов и resolve). */
export async function getUser(viewer: number, id: number): Promise<PublicUser> {
  const [r] = await sql<Row[]>`select ${COLS} from users where id = ${id}`;
  if (!r) throw new DomainError('not_found');
  if (id !== viewer) {
    const [shared] = await sql`select exists (select 1 from chat_members a join chat_members b on b.chat_id = a.chat_id where a.user_id = ${id} and b.user_id = ${viewer}) as ok`;
    if (!shared.ok) throw new DomainError('not_found');
  }
  return publicUser(viewer, r);
}

// ---------- валидация ----------

// C0/C1, bidi-переопределения и изоляты, U+200B, BOM. ZWJ/ZWNJ оставляем: на них держатся составные эмодзи и персидский.
const BAD_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069\u200B\uFEFF]/u;

function validName(v: unknown, min: number): string {
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
    if (JSON.stringify(cur) === JSON.stringify(r)) return { userId: r.id, ...shape(r) }; // ничего не изменилось — журнал не трогаем
    const viewers = await viewersOf(tx, userId);
    // каждому — своё представление (B6: скрытые поля)
    await appendUpdates(tx, [userId, ...viewers].map((v) => ({ userId: v, update: { type: 'userUpdated' as const, user: publicUser(v, r) } })));
    return { userId: r.id, ...shape(r) };
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
