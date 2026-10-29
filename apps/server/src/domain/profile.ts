import { normalizeLinks, USERNAME, type Birthday, type Me, type PersonalChannel, type ProfileLink, type ProfileMusicSummary, type ProfilePhoto, type PublicUser, type UserPhoto } from '@relay/protocol';
import { isTx, sql, type Tx } from '../db';
import { DomainError } from './errors';
import { appendUpdates, flushJournals } from './journal';
import { blocksViewer, canSee, privacyCtx, type PrivacyCtx } from './privacy';

const RESERVED = new Set(['admin', 'relay', 'support', 'settings', 'help', 'api', 'root', 'system', 'null', 'undefined', 'me']);
const len = (s: string) => [...s].length;

export type Row = { id: number; name: string; first_name: string | null; last_name: string | null; username: string | null; bio: string | null; birthday: Birthday | null; phone: string | null; links: ProfileLink[]; photo: ProfilePhoto | null; music: ProfileMusicSummary | null; personal_channel: PersonalChannel | null };

/**
 * Личный канал строкой профиля: только пока он публичный, не удалён и принадлежит этому пользователю — даже если
 * сброс в groups.ts (dropPersonalChannel) разминулся с сохранением профиля, наружу устаревший канал не уйдёт.
 * u — таблица users в запросе (`users` или алиас).
 */
export const personalChannelSql = (u: 'users' | 'u') => sql`(
  select json_build_object('id', c.id, 'title', coalesce(c.title, ''), 'username', c.username, 'photo', c.photo, 'members', c.members_count)
    from chats c where c.id = ${sql(u)}.personal_channel_id and c.kind = 'channel' and c.username is not null and c.deleted_at is null and c.owner_id = ${sql(u)}.id
) as personal_channel`;
export const COLS = sql`id, name, first_name, last_name, username, bio, birthday, phone, links, photo, music, ${personalChannelSql('users')}`;

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
    username: r.username, bio: r.bio, birthday: r.birthday, phone: r.phone, links: r.links ?? [], photo: r.photo ?? null, music: r.music ?? null,
    personalChannel: r.personal_channel ?? null,
  };
}

/** Последний номер своего журнала: профиль «на момент seq» (см. Me.seq). */
export async function selfSeq(tx: Tx | typeof sql, userId: number): Promise<number> {
  if (isTx(tx)) await flushJournals(tx as Tx);   // записи этой транзакции ещё в буфере — seq ответа должен их учитывать
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

/** Имя, которое владелец дал контакту. */
export type ContactName = { first_name: string; last_name: string };

/**
 * Представление пользователя для конкретного зрителя. Всё, что уходит наружу (HTTP, журнал), идёт через эту функцию.
 * contact — запись зрителя об этом человеке: имя у зрителя — контактное (видно только ему), своё — в publicName.
 * ctx — правила приватности на эту пару (privacyCtx): скрытые поля зритель не получает вовсе.
 */
export function publicUser(viewer: number, r: Row, contact: ContactName | null | undefined, ctx: PrivacyCtx): PublicUser {
  const s = shape(r);
  const c = contact && r.id !== viewer ? contact : null;
  return {
    id: r.id, name: c ? fullName(c.first_name, c.last_name) : s.name,
    firstName: c ? c.first_name : s.firstName, lastName: c ? c.last_name : s.lastName, publicName: s.name,
    username: s.username, links: s.links,   // как @username — видны всем, кто видит профиль
    bio: canSee(viewer, r.id, 'bio', ctx) ? s.bio : null,
    birthday: canSee(viewer, r.id, 'birthday', ctx) ? s.birthday : null,
    phone: canSee(viewer, r.id, 'phone', ctx) ? s.phone : null,
    photo: blocksViewer(viewer, r.id, ctx) ? null : s.photo,   // заблокированному — как в Telegram, без фото
    blocksMe: blocksViewer(viewer, r.id, ctx),
    music: blocksViewer(viewer, r.id, ctx) ? null : s.music,   // как listProfileMusic: заблокированному музыки не видно
    personalChannel: blocksViewer(viewer, r.id, ctx) ? null : s.personalChannel,
  };
}

/** Профиль одного пользователя для одного зрителя (контекст приватности — на эту пару). */
export async function publicUserFor(db: Tx | typeof sql, viewer: number, r: Row, contact?: ContactName | null): Promise<PublicUser> {
  return publicUser(viewer, r, contact, await privacyCtx(db, [[viewer, r.id]]));
}

/** Кто видит пользователя: все, с кем есть общий чат (личный или группа), и те, у кого он в контактах.
 *  Канал общим чатом не считается: подписчики друг друга не видят. */
export async function viewersOf(tx: Tx | typeof sql, userId: number): Promise<number[]> {
  const rows = await tx`
    select b.user_id from chat_members a join chats c on c.id = a.chat_id and c.kind <> 'channel' and c.deleted_at is null join chat_members b on b.chat_id = a.chat_id
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

/**
 * Имя пользователя глазами зрителя в SQL: контактное, если зритель его задал, иначе своё.
 * Таблица users в запросе обязана называться `u`; viewer — id или выражение (например, sql`s.user_id`).
 */
export const nameForSql = (viewer: number | ReturnType<typeof sql>) =>
  sql`coalesce((select nullif(btrim(ct.first_name || ' ' || ct.last_name), '') from contacts ct where ct.owner_id = ${viewer} and ct.user_id = u.id), u.name)`;

/**
 * Комментарии без вступления (threads.ts threadAccess): автор комментария виден гостю треда — подписчику канала, чья
 * это группа обсуждения (корень треда — копия поста этого канала, гость в группе не в бане), а гость-комментатор —
 * участникам группы. target — id или выражение (sql`users.id`).
 */
export const commentPeerSql = (db: Tx | typeof sql, viewer: number, target: number | ReturnType<typeof sql>) => db`(
  exists (select 1 from chat_members vm
            join chats ch on ch.id = vm.chat_id and ch.kind = 'channel' and ch.deleted_at is null and ch.linked_chat_id is not null
            join messages cm on cm.chat_id = ch.linked_chat_id and cm.sender_id = ${target} and cm.thread_id is not null and not cm.deleted
            join messages r on r.chat_id = cm.chat_id and r.id = cm.thread_id and (r.origin->>'chatId')::bigint = ch.id
           where vm.user_id = ${viewer}
             and not exists (select 1 from chat_bans b where b.chat_id = ch.linked_chat_id and b.user_id = ${viewer}))
  or exists (select 1 from chat_members gm join chats g on g.id = gm.chat_id and g.kind = 'group' and g.deleted_at is null
               join messages cm on cm.chat_id = gm.chat_id and cm.sender_id = ${target} and cm.thread_id is not null and not cm.deleted
              where gm.user_id = ${viewer}))`;

/** Может ли зритель смотреть профиль: общий чат (не канал) или человек у зрителя в контактах.
 *  Обратное направление («у кого я в контактах») доступа не даёт — иначе оно себя выдаёт. */
export async function canView(db: Tx | typeof sql, viewer: number, id: number): Promise<boolean> {
  if (id === viewer) return true;
  const [r] = await db`select (
      exists (select 1 from chat_members a join chats c on c.id = a.chat_id and c.kind <> 'channel' and c.deleted_at is null join chat_members b on b.chat_id = a.chat_id where a.user_id = ${id} and b.user_id = ${viewer})
      or exists (select 1 from contacts where owner_id = ${viewer} and user_id = ${id})
      or ${commentPeerSql(db, viewer, id)}   -- автор комментария в треде, который я вижу (гостем или участником)
    ) as ok`;
  return !!r.ok;
}

/** Профиль другого пользователя; без общего чата и контакта — 404 (найти по @имени/номеру — /users/resolve). */
export async function getUser(viewer: number, id: number): Promise<PublicUser> {
  const [r] = await sql<Row[]>`select ${COLS} from users where id = ${id}`;
  if (!r || !(await canView(sql, viewer, id))) throw new DomainError('not_found');
  return publicUserFor(sql, viewer, r, (await contactNames(sql, id, [viewer])).get(viewer));
}

/**
 * Правила приватности или чёрный список изменились: журнал зрителей хранит снимки профиля, поэтому тем,
 * у кого представление пользователя стало другим (поле пропало или появилось), — корректирующий userUpdated.
 * before/after — контексты до и после правки (after обычно — withRule/withBlock от before).
 */
export async function republishUser(tx: Tx, userId: number, viewers: number[], before: PrivacyCtx, after: PrivacyCtx): Promise<void> {
  if (!viewers.length) return;
  const [r] = await tx<Row[]>`select ${COLS} from users where id = ${userId}`;
  if (!r) return;
  const names = await contactNames(tx, userId, viewers);
  const out = viewers.flatMap((v) => {
    const was = publicUser(v, r, names.get(v), before), now = publicUser(v, r, names.get(v), after);
    return JSON.stringify(was) === JSON.stringify(now) ? [] : [{ userId: v, update: { type: 'userUpdated' as const, user: now } }];
  });
  await appendUpdates(tx, out);
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

/** Многострочный текст (о себе, заметка): переводы строк — \n, управляющие и bidi/невидимые символы — вон, длина — в кодовых точках. */
export function validText(v: unknown, max: number, code: 'bio_too_long' | 'note_too_long'): string {
  if (typeof v !== 'string') throw new DomainError('bad_frame');
  const s = v.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n]|[\u202A-\u202E\u2066-\u2069\u200B\uFEFF]/gu, '').trim();
  if (len(s) > max) throw new DomainError(code);
  return s;
}

function validBio(v: unknown): string | null {
  if (v === null) return null;
  return validText(v, 140, 'bio_too_long') || null;
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
  if (row && row.id !== userId) return { ok: false, reason: 'taken' };
  return (await channelHolds(sql, s.name)) ? { ok: false, reason: 'taken' } : { ok: true };
}

/** Имена общие с группами и каналами (как checkGroupUsername): /@name не должен стать неоднозначным. Удалённый чат имя не держит. */
const channelHolds = async (db: Tx | typeof sql, name: string) =>
  (await db`select 1 from chats where lower(username) = ${name} and deleted_at is null limit 1`).length > 0;

// ---------- запись + журнал ----------

/** userUpdated себе и всем зрителям: каждому — своё представление (скрытые правилами поля; владельцу контакта — его имя для этого человека). */
async function publishUser(tx: Tx, r: Row): Promise<void> {
  const viewers = await viewersOf(tx, r.id);
  const names = await contactNames(tx, r.id, viewers);
  const ctx = await privacyCtx(tx, viewers.map((v) => [v, r.id]));
  await appendUpdates(tx, [r.id, ...viewers].map((v) => ({ userId: v, update: { type: 'userUpdated' as const, user: publicUser(v, r, names.get(v), ctx) } })));
}

/**
 * Канал перестал подходить в личные (снят @username, сменился владелец, удалён) — в той же транзакции обнулить
 * поле у тех, кто его показывал, и разослать исправленный профиль. Звать после изменения строки chats.
 */
export async function dropPersonalChannel(tx: Tx, chatId: number): Promise<void> {
  const gone = await tx`
    update users u set personal_channel_id = null
      from chats c
     where u.personal_channel_id = ${chatId} and c.id = u.personal_channel_id
       and (c.kind <> 'channel' or c.username is null or c.deleted_at is not null or c.owner_id is distinct from u.id)
    returning u.id`;
  for (const g of gone) {
    const [r] = await tx<Row[]>`select ${COLS} from users where id = ${g.id}`;
    if (r) await publishUser(tx, r);
  }
}

/** Каналы, которые можно поставить в профиль: публичные, не удалённые, где я владелец; по названию. */
export async function personalChannelCandidates(userId: number): Promise<{ channels: PersonalChannel[] }> {
  const rows = await sql`
    select c.id, coalesce(c.title, '') as title, c.username, c.photo, c.members_count from chats c
     where c.owner_id = ${userId} and c.kind = 'channel' and c.username is not null and c.deleted_at is null
     order by lower(coalesce(c.title, '')), c.id limit 200`;
  return { channels: rows.map((r) => ({ id: Number(r.id), title: r.title as string, username: r.username as string, photo: (r.photo as ProfilePhoto | null) ?? null, members: Number(r.members_count) })) };
}

/** Применить изменение профиля и записать userUpdated себе и зрителям — одной транзакцией (и для музыки профиля). */
export async function saveProfile(userId: number, change: (tx: Tx, cur: Row) => Promise<void>): Promise<Me> {
  return sql.begin(async (tx) => {
    const [cur] = await tx<Row[]>`select ${COLS} from users where id = ${userId} for no key update`;
    if (!cur) throw new DomainError('not_found');
    await change(tx, cur);
    const [r] = await tx<Row[]>`select ${COLS} from users where id = ${userId}`;
    if (JSON.stringify(cur) === JSON.stringify(r)) return { userId: r.id, ...shape(r), seq: await selfSeq(tx, userId) }; // ничего не изменилось — журнал не трогаем
    await publishUser(tx, r);
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
  const links = 'links' in p ? normalizeLinks(p.links) ?? (() => { throw new DomainError('links_invalid'); })() : undefined;
  const channel = 'personalChannelId' in p ? p.personalChannelId : undefined;
  if (channel !== undefined && channel !== null && !(Number.isSafeInteger(channel) && (channel as number) > 0)) throw new DomainError('bad_frame', 'personalChannelId');
  return saveProfile(userId, async (tx, cur) => {
    if (typeof channel === 'number') {
      // без замка строки chats: замки «users → chats» здесь и «chats → users» в groups.ts сцепились бы; гонку
      // с dropPersonalChannel закрывает personalChannelSql — устаревший канал наружу не показывается
      const [c] = await tx`select kind, username, deleted_at, owner_id from chats where id = ${channel}`;
      if (!c || c.kind !== 'channel') throw new DomainError('bad_frame', 'not a channel');
      if (Number(c.owner_id) !== userId || c.username === null || c.deleted_at !== null) throw new DomainError('forbidden', 'personal channel');
    }
    if (channel !== undefined) await tx`update users set personal_channel_id = ${channel as number | null} where id = ${userId}`;
    const [pf, pl] = parts(cur);
    const f = first ?? pf;
    const l = last ?? pl;
    const name = fullName(f, l);
    const b = birthday === undefined ? cur.birthday : birthday;
    await tx`update users set first_name = ${f}, last_name = ${l || null}, name = ${name},
               bio = ${bio === undefined ? cur.bio : bio},
               birthday = ${b === null ? null : tx.json(b as never)},
               links = ${tx.json((links ?? cur.links ?? []) as never)}
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
    return await saveProfile(userId, async (tx) => {
      if (name && (await channelHolds(tx, name))) throw new DomainError('username_taken');
      await tx`update users set username = ${name} where id = ${userId}`;
    });
  } catch (e) {
    // гонку решает уникальный индекс, а не проверка «до»
    if ((e as { code?: string }).code === '23505') throw new DomainError('username_taken');
    throw e;
  }
}

// ---------- фото профиля ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** превью — несколько сотен байт: размытая 16×16; больше — уже не превью, а способ раздуть профиль */
const THUMB = /^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/]{16,4000}={0,2}$/;

type PhotoRow = { pid: number; big: string; small: string; thumb: string; video: string | null; at: Date };
const photoOf = (r: PhotoRow): ProfilePhoto => ({ id: r.big, small: r.small, thumb: r.thumb, at: new Date(r.at).getTime(), pid: Number(r.pid), ...(r.video ? { video: r.video } : {}) });
const PHOTO_COLS = sql`id as pid, big::text, small::text, thumb, video::text, created_at as at`;

/** Главное фото после удаления/смены — новейшее из оставшихся (или никакого). */
async function syncMain(tx: Tx, userId: number, pid?: number): Promise<void> {
  const [r] = pid
    ? await tx<PhotoRow[]>`select ${PHOTO_COLS} from user_photos where user_id = ${userId} and id = ${pid}`
    : await tx<PhotoRow[]>`select ${PHOTO_COLS} from user_photos where user_id = ${userId} order by id desc limit 1`;
  await tx`update users set photo = ${r ? tx.json(photoOf(r) as never) : null} where id = ${userId}`;
}

/**
 * Поставить фото: клиент сам обрезал и ужал его до 640 и 160 и загрузил обычной загрузкой (/uploads).
 * Проверяем, что это свои готовые квадратные картинки разумного размера — чужой файл «в профиль» не подсунуть.
 * video — видео-аватарка (квадратное видео до 1280 и 15 с), тогда big/small — её кадр. Фото попадает в историю и становится главным.
 */
export async function setPhoto(userId: number, body: unknown): Promise<Me> {
  const bad = () => new DomainError('photo_invalid');
  if (!body || typeof body !== 'object') throw bad();
  const { id, small, thumb, video } = body as Record<string, unknown>;
  if (typeof id !== 'string' || typeof small !== 'string' || id === small || !UUID.test(id) || !UUID.test(small)) throw bad();
  if (typeof thumb !== 'string' || !THUMB.test(thumb)) throw bad();
  if (video !== undefined && (typeof video !== 'string' || !UUID.test(video) || video === id || video === small)) throw bad();
  const ids = video ? [id, small, video as string] : [id, small];
  // фото профиля — только открытые файлы (enc = 0): их видят все, ключа у зрителей нет
  const rows = await sql`select id, width, height, mime, duration from attachments
    where id = any(${ids}::uuid[]) and owner_id = ${userId} and status = 'ready' and enc = 0`;
  const row = (x: string) => rows.find((a) => a.id === x);
  const side = (x: string) => { const r = row(x); return r && /^image\//.test(r.mime as string) && r.width === r.height ? Number(r.width) : 0; };
  const b = side(id), s = side(small);
  if (b < 160 || b > 1280 || s < 48 || s > 320) throw bad();
  if (video) {
    const v = row(video as string);
    if (!v || !/^video\/(mp4|webm)/.test(v.mime as string) || !v.width || v.width !== v.height || Number(v.width) > 1280 || Number(v.duration ?? 0) > 15) throw bad();
  }
  return saveProfile(userId, async (tx) => {
    const [r] = await tx<PhotoRow[]>`insert into user_photos (user_id, big, small, thumb, video)
      values (${userId}, ${id}, ${small}, ${thumb}, ${(video as string | undefined) ?? null}) returning ${PHOTO_COLS}`;
    await tx`update users set photo = ${tx.json(photoOf(r) as never)} where id = ${userId}`;
  });
}

/** Удалить фото из истории (без pid — главное). Было главным — главным становится следующее. */
export async function deletePhoto(userId: number, pid?: number): Promise<Me> {
  return saveProfile(userId, async (tx, cur) => {
    const target = pid ?? cur.photo?.pid;
    if (target) await tx`delete from user_photos where user_id = ${userId} and id = ${target}`;
    else await tx`update users set photo = null where id = ${userId}`;   // фото без истории (до миграции) — просто снять
    if (target && (!cur.photo || cur.photo.pid === target)) await syncMain(tx, userId);
  });
}

/** Сделать фото из истории главным. */
export async function setMainPhoto(userId: number, pid: number): Promise<Me> {
  return saveProfile(userId, async (tx) => {
    const [r] = await tx`select 1 from user_photos where user_id = ${userId} and id = ${pid}`;
    if (!r) throw new DomainError('not_found');
    await syncMain(tx, userId, pid);
  });
}

/** История фото профиля для зрителя: главное первым, дальше новые сверху. Заблокированному и без доступа к профилю — пусто/404. */
export async function listPhotos(viewer: number, userId: number, offset = 0, limit = 50): Promise<{ photos: UserPhoto[]; total: number }> {
  if (!(await canView(sql, viewer, userId))) throw new DomainError('not_found');
  const [blk] = await sql`select 1 from blocks where owner_id = ${userId} and user_id = ${viewer}`;
  if (blk) return { photos: [], total: 0 };
  const [u] = await sql`select (photo->>'pid')::bigint as main from users where id = ${userId}`;
  const main = u?.main != null ? Number(u.main) : 0;
  const rows = await sql<PhotoRow[]>`select ${PHOTO_COLS} from user_photos where user_id = ${userId}
    order by (id = ${main}) desc, id desc offset ${Math.max(0, offset)} limit ${Math.min(100, Math.max(1, limit))}`;
  const [c] = await sql`select count(*)::int as n from user_photos where user_id = ${userId}`;
  return { photos: rows.map((r) => { const p = photoOf(r); return { pid: p.pid!, id: p.id, small: p.small, thumb: p.thumb, at: p.at, ...(p.video ? { video: p.video } : {}) }; }), total: c.n as number };
}
