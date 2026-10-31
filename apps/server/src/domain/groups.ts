import { peerKey } from '../crypto/peerKey';
import {
  emojiKey, graphemes, normalizeAdminRights, normalizeRights, narrowRights, allAdminRights, ADMIN_RIGHTS_BY_KIND, GROUP_ABOUT_MAX, MEMBERS_MAX, RANK_MAX, SLOW_MODES,
  type AdminRights, type CommunityKind, type ProfilePhoto, type BannedMember, type GroupMember, type GroupReactions, type GroupRole, type Message, type MemberRights, type ServiceData, type ServiceType,
} from '@relay/protocol';
import { sql, type Tx } from '../db';
import { GROUP_TITLE_MAX, readOwnPost, toMessage } from './chats';
import { contentColumns, openRows } from './messageContent';
import { DomainError } from './errors';
import { appendUpdates, chatEvent, type ChatNotify } from './journal';
import { dropPersonalChannel, nameForSql } from './profile';
import { checkPassword } from './password';
import { onlineUsers } from './liveRegistry';
import { presenceFor } from './presence';
import { privacyCtx } from './privacy';
import { enqueue } from '../jobs/queue';
import {
  broadcastGroup, groupInfo, broadcastMembers, canChangeInfo, canInvite, groupCtx, hasAdmin, isCommunity, isGroup, requireAdmin, sendMembership, type GroupCtx, joinMembership, membersOf } from './groupRights';

type Db = Tx | typeof sql;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THUMB = /^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/]{16,4000}={0,2}$/;

/** Имена на момент события (как их видят все: отображаемое имя). */
async function names(db: Db, ids: number[]): Promise<{ id: number; name: string }[]> {
  if (!ids.length) return [];
  const rows = await db`select id, name from users where id = any(${ids}::bigint[])`;
  const by = new Map(rows.map((r) => [Number(r.id), r.name as string]));
  return ids.map((id) => ({ id, name: by.get(id) ?? '' }));
}

/** Служебное сообщение группы: в ленту всем участникам (и extra — тем, кого уже нет, чтобы увидели «вас удалили»).
 *  В канале — от имени канала (post: senderId 0), как и посты: какой админ сменил название, подписчики не видят. */
export async function serviceMessage(tx: Tx, chatId: number, senderId: number, type: ServiceType, data: ServiceData = {}, body = '', kind: 'direct' | 'group' | 'channel' = 'group'): Promise<Message> {
  const clientId = crypto.randomUUID();
  const c = await contentColumns(chatId, clientId, { body, entities: null, todo: null, blocks: null, link: null, attachment: null }, tx);
  const [row] = await tx`
    insert into messages (chat_id, sender_id, client_id, kind, body, service_type, service_data, content, post)
    values (${chatId}, ${senderId}, ${clientId}, 'text', ${c.body}, ${type}, ${Object.keys(data).length ? tx.json(data as never) : null}, ${c.content},
            (select kind = 'channel' from chats where id = ${chatId})) returning *`;
  const message = toMessage((await openRows([row], '', tx))[0]);
  await chatEvent(tx, chatId, { type: 'newMessage', message }, kind === 'direct' ? 'direct' : 'group');
  if (message.post) await readOwnPost(tx, chatId, senderId, message.id);   // в канале — от канала: своё не непрочитанное
  return message;
}

export function validTitle(raw: unknown): string {
  const title = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new DomainError('bad_frame', 'title');
  if (graphemes(title) > GROUP_TITLE_MAX) throw new DomainError('too_long', 'title');
  return title;
}

function validAbout(raw: unknown): string {
  if (typeof raw !== 'string') throw new DomainError('bad_frame', 'about');
  const about = raw.replace(/\r\n?/g, '\n').trim();
  if (graphemes(about) > GROUP_ABOUT_MAX) throw new DomainError('too_long', 'about');
  return about;
}

function validRank(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw new DomainError('bad_frame', 'rank');
  const rank = raw.replace(/\s+/g, ' ').trim();
  if (graphemes(rank) > RANK_MAX) throw new DomainError('too_long', 'rank');
  return rank || null;
}

/** Название и описание. Смена названия — служебным сообщением, как в Telegram. */
export async function updateGroupInfo(userId: number, chatId: number, body: { title?: unknown; about?: unknown }): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isCommunity(ctx);
    if (!canChangeInfo(ctx)) throw new DomainError('forbidden', 'info');
    const [c] = await tx`select title, about from chats where id = ${chatId}`;
    let changed = false;
    if (body.title !== undefined) {
      const title = validTitle(body.title);
      if (title !== c.title) {
        await tx`update chats set title = ${title} where id = ${chatId}`;
        await serviceMessage(tx, chatId, userId, 'title_changed', { title }, title);
        changed = true;
      }
    }
    if (body.about !== undefined) {
      const about = validAbout(body.about);
      if (about !== ((c.about as string | null) ?? '')) {
        await tx`update chats set about = ${about || null} where id = ${chatId}`;
        changed = true;
      }
    }
    if (changed) await broadcastGroup(tx, chatId);
    return { ok: true };
  });
}

/** Фото группы: клиент сам обрезал до 640 и 160 и загрузил (как фото профиля). null — убрать. */
export async function setGroupPhoto(userId: number, chatId: number, body: unknown): Promise<{ ok: true }> {
  let photo: { id: string; small: string; thumb: string } | null = null;
  if (body !== null) {
    const { id, small, thumb } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const bad = () => new DomainError('photo_invalid');
    if (typeof id !== 'string' || typeof small !== 'string' || id === small || !UUID.test(id) || !UUID.test(small)) throw bad();
    if (typeof thumb !== 'string' || !THUMB.test(thumb)) throw bad();
    const rows = await sql`select id, width, height, mime from attachments where enc = 0 and id = any(${[id, small]}::uuid[]) and owner_id = ${userId} and status = 'ready'`;
    const side = (x: string) => { const r = rows.find((a) => a.id === x); return r && /^image\//.test(r.mime as string) && r.width === r.height ? Number(r.width) : 0; };
    const b = side(id), s = side(small);
    if (b < 160 || b > 1280 || s < 48 || s > 320) throw bad();
    photo = { id, small, thumb };
  }
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isCommunity(ctx);
    if (!canChangeInfo(ctx)) throw new DomainError('forbidden', 'info');
    if (photo) {
      const [p] = await tx`insert into chat_photos (chat_id, big, small, thumb) values (${chatId}, ${photo.id}, ${photo.small}, ${photo.thumb}) returning id, created_at`;
      const value = { id: photo.id, small: photo.small, thumb: photo.thumb, at: new Date(p.created_at as string).getTime(), pid: Number(p.id) };
      await tx`update chats set photo = ${tx.json(value as never)} where id = ${chatId}`;
      await serviceMessage(tx, chatId, userId, 'photo_changed');
    } else {
      const [c] = await tx`select photo from chats where id = ${chatId}`;
      if (!c.photo) return { ok: true };
      await tx`update chats set photo = null where id = ${chatId}`;
      await serviceMessage(tx, chatId, userId, 'photo_removed');
    }
    await broadcastGroup(tx, chatId);
    return { ok: true };
  });
}

/** Права участников по умолчанию и медленный режим (админ с правом блокировать). Каждому — его новые права. */
export async function setGroupRights(userId: number, chatId: number, body: { rights?: unknown; slowMode?: unknown }): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isGroup(ctx);   // права участников и медленный режим — только у группы
    requireAdmin(ctx, 'ban');
    if (body.rights !== undefined) await tx`update chats set rights = ${tx.json(normalizeRights(body.rights) as never)} where id = ${chatId}`;
    if (body.slowMode !== undefined) {
      const s = Number(body.slowMode);
      if (!SLOW_MODES.includes(s)) throw new DomainError('bad_frame', 'slowMode');
      await tx`update chats set slow_mode = ${s} where id = ${chatId}`;
    }
    await broadcastGroup(tx, chatId);
    for (const id of await membersOf(tx, chatId)) await sendMembership(tx, chatId, id);
    return { ok: true };
  });
}

/** История для новых, одобрение вступающих, запрет копирования, реакции; у канала — подписи постов; у группы — «комментировать только участникам». */
export async function setGroupSettings(userId: number, chatId: number, body: { historyHidden?: unknown; joinApproval?: unknown; joinToSend?: unknown; protected?: unknown; reactions?: unknown; signatures?: unknown }): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isCommunity(ctx);
    const [c] = await tx`select history_hidden, join_approval, protected, linked_chat_id from chats where id = ${chatId}`;
    if (body.historyHidden !== undefined) {
      isGroup(ctx);
      requireAdmin(ctx, 'ban');
      // группа обсуждения канала: история видна всем (тред читают и вступившие позже)
      if (body.historyHidden === true && c.linked_chat_id != null) throw new DomainError('forbidden', 'linked');
      await tx`update chats set history_hidden = ${body.historyHidden === true} where id = ${chatId}`;
    }
    // группа обсуждения: писать в тред — только вступившим (иначе комментируют и подписчики канала, не вступая)
    if (body.joinToSend !== undefined) {
      isGroup(ctx);
      if (!hasAdmin(ctx, 'ban') && !hasAdmin(ctx, 'info')) throw new DomainError('forbidden', 'ban');
      await tx`update chats set join_to_send = ${body.joinToSend === true} where id = ${chatId}`;
    }
    if (body.signatures !== undefined) {
      if (ctx.kind !== 'channel') throw new DomainError('bad_frame', 'not a channel');
      requireAdmin(ctx, 'info');
      await tx`update chats set signatures = ${body.signatures === true} where id = ${chatId}`;
    }
    if (body.joinApproval !== undefined) {
      requireAdmin(ctx, 'invite');
      await tx`update chats set join_approval = ${body.joinApproval === true} where id = ${chatId}`;
      // одобрение выключили — ждущие заявки принимаются
      if (body.joinApproval !== true && c.join_approval) {
        for (const r of await tx`select user_id from chat_join_requests where chat_id = ${chatId}`) await acceptMember(tx, chatId, Number(r.user_id), userId, 'joined_by_request');
        await tx`delete from chat_join_requests where chat_id = ${chatId}`;
      }
    }
    if (body.protected !== undefined) {
      if (ctx.role !== 'owner') throw new DomainError('forbidden', 'owner');
      const on = body.protected === true;
      if (on !== !!c.protected) {
        await tx`update chats set protected = ${on} where id = ${chatId}`;
        await serviceMessage(tx, chatId, userId, on ? 'protected_on' : 'protected_off');
      }
    }
    if (body.reactions !== undefined) {
      requireAdmin(ctx, 'info');
      const o = (body.reactions && typeof body.reactions === 'object' ? body.reactions : {}) as Record<string, unknown>;
      const mode = o.mode === 'some' || o.mode === 'none' ? o.mode : o.mode === 'all' ? 'all' : null;
      if (!mode) throw new DomainError('bad_frame', 'reactions');
      // храним ключи без FE0F (как шлёт клиент), дубли по ключу схлопываем
      const allowed = mode === 'some' && Array.isArray(o.allowed) ? [...new Set(o.allowed.filter((e): e is string => typeof e === 'string' && e.length <= 16).map(emojiKey))].slice(0, 100) : [];
      const value: GroupReactions = { mode, allowed };
      await tx`update chats set reactions = ${tx.json(value as never)} where id = ${chatId}`;
    }
    await broadcastGroup(tx, chatId);
    return { ok: true };
  });
}

/** Публичная группа (юзернейм) или частная (null). Пространство имён общее с пользователями. Только владелец. */
export async function setGroupUsername(userId: number, chatId: number, raw: unknown): Promise<{ ok: true }> {
  const name = raw == null || raw === '' ? null : typeof raw === 'string' ? raw.trim().replace(/^@/, '') : '';
  if (name !== null && !/^[a-z][a-z0-9_]{4,31}$/i.test(name)) throw new DomainError('username_invalid');
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isCommunity(ctx);
    if (ctx.role !== 'owner') throw new DomainError('forbidden', 'owner');
    if (name) {
      const [u] = await tx`select 1 from users where lower(username) = lower(${name}) union all select 1 from chats where lower(username) = lower(${name}) and id <> ${chatId} limit 1`;
      if (u) throw new DomainError('username_taken');
    }
    await tx`update chats set username = ${name ? name.toLowerCase() : null} where id = ${chatId}`;
    if (!name) await dropPersonalChannel(tx, chatId);   // приватный канал в профиле не показывается
    await broadcastGroup(tx, chatId);
    return { ok: true };
  });
}

export async function checkGroupUsername(raw: unknown, chatId?: number): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'taken' }> {
  const name = typeof raw === 'string' ? raw.trim().replace(/^@/, '') : '';
  if (!/^[a-z][a-z0-9_]{4,31}$/i.test(name)) return { ok: false, reason: 'invalid' };
  const [u] = await sql`select 1 from users where lower(username) = lower(${name}) union all select 1 from chats where lower(username) = lower(${name}) and id <> ${chatId ?? 0} limit 1`;
  return u ? { ok: false, reason: 'taken' } : { ok: true };
}

const MEMBER_COLS = (viewer: number) => sql`
  u.id, ${nameForSql(viewer)} as name, u.username, u.last_seen_at,
  case when exists (select 1 from blocks b where b.owner_id = u.id and b.user_id = ${viewer}) then null else u.photo end as photo,
  m.role, m.rank, m.admin_rights, m.promoted_by, m.restricted, m.inviter_id, m.joined_at`;

/** Участники с ролями. filter: all | admins | restricted. Присутствие — по правилам приватности (presence.ts).
 *  Подписчики канала — только админам: подписчики не видят состав. */
export async function listGroupMembers(viewer: number, chatId: number, filter = 'all', q = ''): Promise<{ members: GroupMember[] }> {
  const ctx = await groupCtx(sql, chatId, viewer);
  isCommunity(ctx);
  if (ctx.kind === 'channel' && !ctx.admin) throw new DomainError('forbidden', 'members');
  const ck: CommunityKind = ctx.kind === 'channel' ? 'channel' : 'group';
  const like = q.trim() ? '%' + q.trim().toLowerCase().replace(/[%_\\]/g, (c) => '\\' + c) + '%' : null;
  const rows = await sql`
    select ${MEMBER_COLS(viewer)} from chat_members m join users u on u.id = m.user_id
     where m.chat_id = ${chatId} and not u.system
       ${filter === 'admins' ? sql`and m.role in ('owner', 'admin')` : filter === 'restricted' ? sql`and m.role = 'member' and m.restricted is not null` : sql``}
       ${like ? sql`and (lower(u.name) like ${like} or lower(coalesce(u.username, '')) like ${like})` : sql``}
     order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.joined_at
     limit 1000`;
  const defaults = ctx.defaults;
  const ids = rows.map((r) => Number(r.id));
  const pctx = await privacyCtx(sql, ids.filter((id) => id !== viewer).map((id) => [viewer, id] as [number, number]));
  const online = await onlineUsers(ids);
  return {
    members: rows.map((r) => ({
      ...(Number(r.id) === viewer ? { online: true, lastSeen: null } : (({ online, lastSeen }) => ({ online, lastSeen }))(presenceFor(viewer, Number(r.id), r.last_seen_at, pctx, online.has(Number(r.id))))),
      userId: Number(r.id),
      ...(Number(r.id) !== viewer ? { key: peerKey(viewer, Number(r.id)) } : {}),
      name: r.name as string,
      username: (r.username as string | null) ?? null,
      photo: (r.photo as GroupMember['photo']) ?? null,
      role: r.role as GroupRole,
      rank: (r.rank as string | null) ?? null,
      admin: r.role === 'owner' ? allAdminRights(ck) : r.role === 'admin' ? normalizeAdminRights(r.admin_rights, ck) : null,
      promotedBy: r.promoted_by == null ? null : Number(r.promoted_by),
      restricted: r.role === 'member' && r.restricted ? narrowRights(normalizeRights(r.restricted), defaults) : null,
      inviterId: r.inviter_id == null ? null : Number(r.inviter_id),
      joinedAt: new Date(r.joined_at as string).toISOString(),
    })),
  };
}

export async function listBanned(viewer: number, chatId: number): Promise<{ banned: BannedMember[] }> {
  const ctx = await groupCtx(sql, chatId, viewer);
  requireAdmin(ctx, 'ban');
  const rows = await sql`
    select u.id, u.name, u.photo, b.banned_by, bu.name as banned_by_name, b.at
      from chat_bans b join users u on u.id = b.user_id left join users bu on bu.id = b.banned_by
     where b.chat_id = ${chatId} order by b.at desc limit 1000`;
  return { banned: rows.map((r) => ({ userId: Number(r.id), name: r.name as string, photo: (r.photo as BannedMember['photo']) ?? null, bannedBy: r.banned_by == null ? null : Number(r.banned_by), bannedByName: (r.banned_by_name as string | null) ?? null, at: new Date(r.at as string).toISOString() })) };
}

/**
 * Добавить в группу (участником). Видимая история — с момента вступления, если история для новых скрыта.
 * Не шлёт служебное — вызывающий решает, каким оно будет (добавил(а) / вступил(а) по ссылке / заявка принята).
 */
async function insertMember(tx: Tx, chatId: number, userId: number, inviterId: number | null, keep: boolean): Promise<boolean> {
  const [c] = await tx`select history_hidden, (select coalesce(max(id), 0) from messages where chat_id = ${chatId}) as last_id from chats where id = ${chatId}`;
  const from = c.history_hidden ? Number(c.last_id) + 1 : 0;
  // вернулся сам (keep: ссылка, заявка, из треда) — с прежними ограничениями; добавил админ — ограничения сняты (решил он)
  const [r] = keep
    ? await tx`delete from chat_restrictions where chat_id = ${chatId} and user_id = ${userId} returning restricted, history_from`
    : await tx`delete from chat_restrictions where chat_id = ${chatId} and user_id = ${userId} returning null as restricted, 0 as history_from`;
  const ins = await tx`insert into chat_members (chat_id, user_id, inviter_id, history_from, restricted)
                       values (${chatId}, ${userId}, ${inviterId}, ${Math.max(from, Number(r?.history_from ?? 0))}, ${r?.restricted ? tx.json(r.restricted as never) : null})
                       on conflict do nothing returning 1`;
  return ins.length > 0;
}

/** Вид чата и число участников (members_count держит триггер — счёт без count(*); своя транзакция видит свои вставки). */
async function chatSize(db: Db, chatId: number): Promise<{ kind: CommunityKind; n: number }> {
  const [c] = await db`select kind, members_count from chats where id = ${chatId}`;
  return { kind: c.kind === 'channel' ? 'channel' : 'group', n: Number(c.members_count) };
}

/**
 * Вступление по ссылке, юзернейму или принятой заявке: участник, служебное, всем — новый состав.
 * Канал: только membership новичку — ни служебного, ни groupUpdated, ни members (O(1) на вступление при 200 000).
 */
export async function acceptMember(tx: Tx, chatId: number, userId: number, actorId: number | null, type: 'joined_by_link' | 'joined_by_request' | 'members_added'): Promise<boolean> {
  const { kind, n } = await chatSize(tx, chatId);
  if (n >= MEMBERS_MAX[kind]) throw new DomainError('too_long', 'members');
  if (!(await insertMember(tx, chatId, userId, actorId, type !== 'members_added'))) return false;
  await tx`delete from chat_join_requests where chat_id = ${chatId} and user_id = ${userId}`;
  if (kind === 'channel') {
    // канал: вступивший начинает с прочитанного (как в Telegram) — история не становится сотней непрочитанных
    await tx`update chat_members set last_read_id = (select coalesce(max(id), 0) from messages where chat_id = ${chatId}) where chat_id = ${chatId} and user_id = ${userId}`;
    await joinMembership(tx, chatId, userId);
    return true;
  }
  await serviceMessage(tx, chatId, userId, type, { users: await names(tx, [userId]) });
  await joinMembership(tx, chatId, userId);   // с seq чата на момент коммита: новичок ничего не догоняет
  await broadcastGroup(tx, chatId);
  await broadcastMembers(tx, chatId, { upsert: [userId], joined: [userId] });
  return true;
}

/**
 * Добавить людей. Нельзя — системных, несуществующих, тех, с кем блокировка; удалённых возвращает только тот,
 * кто может блокировать (это и разблокирует). Кого нельзя добавить — в ответе (клиент предложит ссылку).
 */
export async function addGroupMembers(userId: number, chatId: number, rawIds: unknown): Promise<{ added: number[]; failed: number[] }> {
  if (!Array.isArray(rawIds)) throw new DomainError('bad_frame', 'userIds');
  const ids = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== userId))].slice(0, MEMBERS_MAX.group);   // за один запрос — не больше группы
  if (!ids.length) throw new DomainError('bad_frame', 'userIds');
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isCommunity(ctx);
    if (!canInvite(ctx)) throw new DomainError('forbidden', 'invite');
    const max = MEMBERS_MAX[ctx.kind === 'channel' ? 'channel' : 'group'];
    const ok = await tx`
      select u.id from users u
       where u.id = any(${ids}::bigint[]) and not u.system
         and not exists (select 1 from blocks b where (b.owner_id = ${userId} and b.user_id = u.id) or (b.owner_id = u.id and b.user_id = ${userId}))
         and not exists (select 1 from chat_members m where m.chat_id = ${chatId} and m.user_id = u.id)`;
    const okIds = ok.map((r) => Number(r.id));
    const banned = new Set((await tx`select user_id from chat_bans where chat_id = ${chatId} and user_id = any(${okIds}::bigint[])`).map((r) => Number(r.user_id)));
    const canUnban = hasAdmin(ctx, 'ban');
    const added: number[] = [];
    for (const id of okIds) {
      if (banned.has(id) && !canUnban) continue;
      if ((await chatSize(tx, chatId)).n >= max) break;
      if (banned.has(id)) await tx`delete from chat_bans where chat_id = ${chatId} and user_id = ${id}`;
      if (await insertMember(tx, chatId, id, userId, false)) added.push(id);
    }
    const already = new Set((await tx`select user_id from chat_members where chat_id = ${chatId} and user_id = any(${ids}::bigint[])`).map((r) => Number(r.user_id)));
    const failed = ids.filter((id) => !already.has(id));
    if (added.length && ctx.kind === 'channel') {   // канал: только membership добавленным
      await tx`delete from chat_join_requests where chat_id = ${chatId} and user_id = any(${added}::bigint[])`;
      for (const id of added) await joinMembership(tx, chatId, id);
    } else if (added.length) {
      await tx`delete from chat_join_requests where chat_id = ${chatId} and user_id = any(${added}::bigint[])`;
      await serviceMessage(tx, chatId, userId, 'members_added', { users: await names(tx, added) });
      for (const id of added) await joinMembership(tx, chatId, id);
      await broadcastGroup(tx, chatId);
      await broadcastMembers(tx, chatId, { upsert: added, joined: added });
    }
    return { added, failed };
  });
}

/** Убрать из группы: служебное, удалённому — chatRemoved, всем — новый состав. Канал — только chatRemoved ушедшему. */
async function dropMember(tx: Tx, chatId: number, target: number, actor: number, type: 'member_left' | 'member_removed', kind: GroupCtx['kind']): Promise<void> {
  if (kind !== 'channel') await serviceMessage(tx, chatId, actor, type, { users: await names(tx, [target]) });
  // ограничения переживают выход (chat_restrictions): гость треда и вернувшийся по ссылке — с теми же правами и историей
  if (kind === 'group') await tx`
    insert into chat_restrictions (chat_id, user_id, restricted, history_from)
    select chat_id, user_id, restricted, history_from from chat_members
     where chat_id = ${chatId} and user_id = ${target} and role = 'member' and (restricted is not null or history_from > 0)
    on conflict (chat_id, user_id) do update set restricted = excluded.restricted, history_from = excluded.history_from`;
  await tx`delete from chat_members where chat_id = ${chatId} and user_id = ${target}`;
  await tx`delete from drafts where chat_id = ${chatId} and user_id = ${target}`;
  await tx`delete from message_mentions where user_id = ${target} and chat_id = ${chatId}`;
  await tx`delete from unread_reactions where user_id = ${target} and chat_id = ${chatId}`;
  await appendUpdates(tx, [{ userId: target, update: { type: 'chatRemoved', chatId } }]);
  if (kind === 'channel') return;
  await broadcastGroup(tx, chatId);
  await broadcastMembers(tx, chatId, { remove: [target] });
}

/** Может ли актор управлять этим админом: владелец — любым, админ с правом назначать — только назначенными им. */
function canManageAdmin(ctx: GroupCtx, target: { role: GroupRole; promoted_by: unknown }): boolean {
  if (target.role === 'owner') return false;
  if (ctx.role === 'owner') return true;
  if (target.role !== 'admin') return hasAdmin(ctx, 'addAdmins');
  return hasAdmin(ctx, 'addAdmins') && Number(target.promoted_by) === ctx.userId;
}

/** Удалить участника (бан: в «Удалённые») или выйти самому. Владелец выходит — права переходят дальше. */
export async function removeGroupMember(userId: number, chatId: number, target: number): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    // свой выход может удалить чат (последний владелец) — тогда запирается и связанный: оба замка заранее, по порядку
    if (target === userId) await lockWithLinked(tx, chatId);
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isCommunity(ctx);
    if (target === userId) {
      if (ctx.role === 'owner') {
        // новый владелец — самый давний админ, иначе самый давний участник; никого — группа удаляется.
        // Канал: только админ (подписчик не получает канал на 200 000 случайно); админа нет — сначала передать права
        const [next] = await tx`select user_id from chat_members where chat_id = ${chatId} and user_id <> ${userId}
                                 ${ctx.kind === 'channel' ? tx`and role = 'admin'` : tx``}
                                 order by case role when 'admin' then 0 else 1 end, joined_at limit 1`;
        if (!next && ctx.kind === 'channel') throw new DomainError('forbidden', 'transfer ownership first');
        if (!next) { await deleteGroupTx(tx, chatId); return { ok: true }; }
        await makeOwner(tx, chatId, Number(next.user_id), userId);
      }
      await dropMember(tx, chatId, userId, userId, 'member_left', ctx.kind);
      return { ok: true };
    }
    requireAdmin(ctx, 'ban');
    const [t] = await tx`select role, promoted_by from chat_members where chat_id = ${chatId} and user_id = ${target}`;
    if (!t) throw new DomainError('not_found', 'member');
    if (t.role !== 'member' && !canManageAdmin(ctx, t as never)) throw new DomainError('forbidden', 'admin');
    await tx`insert into chat_bans (chat_id, user_id, banned_by) values (${chatId}, ${target}, ${userId}) on conflict (chat_id, user_id) do update set banned_by = excluded.banned_by, at = now()`;
    await dropMember(tx, chatId, target, userId, 'member_removed', ctx.kind);
    return { ok: true };
  });
}

/** Удалить (бан) того, кого в группе уже нет — из «Удалённых» через «+», или не пустить заранее. */
export async function unbanGroupMember(userId: number, chatId: number, target: number): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    requireAdmin(await groupCtx(tx, chatId, userId), 'ban');
    await tx`delete from chat_bans where chat_id = ${chatId} and user_id = ${target}`;
    return { ok: true };
  });
}

/** Исключение для участника: его права (не шире умолчаний); null — как у всех. */
export async function restrictGroupMember(userId: number, chatId: number, target: number, raw: unknown): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isGroup(ctx);   // исключения — только у группы
    requireAdmin(ctx, 'ban');
    const [t] = await tx`select role from chat_members where chat_id = ${chatId} and user_id = ${target}`;
    if (!t) throw new DomainError('not_found', 'member');
    if (t.role !== 'member') throw new DomainError('forbidden', 'admin');
    const value = raw == null ? null : narrowRights(normalizeRights(raw), ctx.defaults);
    // совпадает с умолчаниями — это не исключение
    const same = value && Object.keys(value).every((k) => value[k as keyof MemberRights] === ctx.defaults[k as keyof MemberRights]);
    await tx`update chat_members set restricted = ${value && !same ? tx.json(value as never) : null} where chat_id = ${chatId} and user_id = ${target}`;
    await sendMembership(tx, chatId, target);
    await broadcastMembers(tx, chatId, { upsert: [target] });
    return { ok: true };
  });
}

/** Назначить админа или поправить права/звание (rights: null — снять). Нельзя дать право, которого нет у себя. */
export async function setGroupAdmin(userId: number, chatId: number, target: number, body: { rights?: unknown; rank?: unknown }): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    requireAdmin(ctx, 'addAdmins');
    const [t] = await tx`select role, promoted_by from chat_members where chat_id = ${chatId} and user_id = ${target}`;
    if (!t) throw new DomainError('not_found', 'member');
    if (!canManageAdmin(ctx, t as never)) throw new DomainError('forbidden', 'admin');
    if (body.rights === null) {
      await tx`update chat_members set role = 'member', admin_rights = null, rank = null, promoted_by = null where chat_id = ${chatId} and user_id = ${target}`;
    } else {
      const ck: CommunityKind = ctx.kind === 'channel' ? 'channel' : 'group';
      const rights: AdminRights = normalizeAdminRights(body.rights, ck);
      for (const r of ADMIN_RIGHTS_BY_KIND[ck]) if (rights[r] && !ctx.admin![r]) throw new DomainError('forbidden', r);
      const rank = body.rank === undefined ? undefined : validRank(body.rank);
      await tx`update chat_members set role = 'admin', admin_rights = ${tx.json(rights as never)}, restricted = null,
                 promoted_by = case when role = 'admin' then promoted_by else ${userId} end
                 ${rank !== undefined ? tx`, rank = ${rank}` : tx``}
               where chat_id = ${chatId} and user_id = ${target}`;
    }
    await sendMembership(tx, chatId, target);
    await broadcastGroup(tx, chatId, [target]);   // список тех, кто видит заявки, мог поменяться: снятому — joinRequests 0
    await broadcastMembers(tx, chatId, { upsert: [target] });
    return { ok: true };
  });
}

/** Звание: своё (админ или владелец), владелец — любому админу, админ с правом назначать — назначенным им. */
export async function setGroupRank(userId: number, chatId: number, target: number, raw: unknown): Promise<{ ok: true }> {
  const rank = validRank(raw);
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId);
    isGroup(ctx);
    const [t] = await tx`select role, promoted_by from chat_members where chat_id = ${chatId} and user_id = ${target}`;
    if (!t) throw new DomainError('not_found', 'member');
    if (t.role === 'member') throw new DomainError('forbidden', 'not admin');
    const own = target === userId;
    if (!own && !(ctx.role === 'owner' || canManageAdmin(ctx, t as never))) throw new DomainError('forbidden', 'rank');
    await tx`update chat_members set rank = ${rank} where chat_id = ${chatId} and user_id = ${target}`;
    await sendMembership(tx, chatId, target);
    await broadcastMembers(tx, chatId, { upsert: [target] });
    return { ok: true };
  });
}

async function makeOwner(tx: Tx, chatId: number, target: number, prev: number): Promise<void> {
  const { kind } = await chatSize(tx, chatId);
  await tx`update chats set owner_id = ${target} where id = ${chatId}`;
  await dropPersonalChannel(tx, chatId);   // личный канал прежнего владельца
  await tx`update chat_members set role = 'owner', admin_rights = null, restricted = null, promoted_by = null where chat_id = ${chatId} and user_id = ${target}`;
  // прежний владелец остаётся админом со всеми правами (как в Telegram)
  await tx`update chat_members set role = 'admin', admin_rights = ${tx.json(allAdminRights(kind) as never)}, promoted_by = ${target} where chat_id = ${chatId} and user_id = ${prev}`;
  // в канале владелец подписчикам не раскрывается — служебного «X теперь владелец» там нет
  if (kind !== 'channel') await serviceMessage(tx, chatId, prev, 'owner_changed', { users: await names(tx, [target]) });
  await sendMembership(tx, chatId, target);
  await sendMembership(tx, chatId, prev).catch(() => {});   // прежний мог уже выйти
  await broadcastGroup(tx, chatId, [prev]);
  if (kind === 'channel') await sendOwnerToAdmins(tx, chatId);
  await broadcastMembers(tx, chatId, { upsert: [target, prev] });
}

/** Канал: общая запись groupUpdated несёт ownerId null — админам новый владелец личной записью (O(админов)). */
async function sendOwnerToAdmins(tx: Tx, chatId: number): Promise<void> {
  const { pending, kind, ...info } = await groupInfo(tx, chatId);
  const admins = await tx`select user_id from chat_members where chat_id = ${chatId} and role in ('owner', 'admin')`;
  await appendUpdates(tx, admins.map((r) => ({ userId: Number(r.user_id), update: { type: 'groupUpdated' as const, chatId, group: { ...info, requests: 0 } } })));
}

/** Передать права на группу: только владелец и только с паролем 2FA (как в Telegram). */
export async function transferGroupOwnership(userId: number, chatId: number, target: number, proof: unknown): Promise<{ ok: true }> {
  const ctx = await groupCtx(sql, chatId, userId);
  isCommunity(ctx);
  if (ctx.role !== 'owner') throw new DomainError('forbidden', 'owner');
  if (target === userId) throw new DomainError('bad_frame', 'target');
  const [pw] = await sql`select 1 from user_passwords where user_id = ${userId}`;
  if (!pw) throw new DomainError('password_missing');
  if (!(await checkPassword(userId, proof))) throw new DomainError('password_invalid');
  return sql.begin(async (tx) => {
    const again = await groupCtx(tx, chatId, userId, { lock: true });
    if (again.role !== 'owner') throw new DomainError('forbidden', 'owner');
    const [t] = await tx`select 1 from chat_members m join users u on u.id = m.user_id where m.chat_id = ${chatId} and m.user_id = ${target} and not u.system`;
    if (!t) throw new DomainError('not_found', 'member');
    await makeOwner(tx, chatId, target, userId);
    return { ok: true };
  });
}

/**
 * Удаление группы или канала — мягкое: deleted_at, и с этого момента чат для всех «пропал» (groupCtx, список,
 * syncChat → not_found/chatGone). Строки участников (chatRemoved каждому), сообщения и сам чат убирает задача
 * chat.purge страницами (chatPurge.ts) — без одной гигантской транзакции на 200 000 участников.
 */
async function deleteGroupTx(tx: Tx, chatId: number): Promise<void> {
  const [c] = await tx`select linked_chat_id from chats where id = ${chatId}`;
  await tx`update chats set deleted_at = now(), linked_chat_id = null where id = ${chatId}`;
  // ключи — сразу, не дожидаясь постраничной чистки (CRYPTO-7): ей они не нужны, а отправка в удалённый чат закрыта.
  // Триггер NOTIFY chat_keys сбрасывает кэши ключей во всех процессах. Документы поиска — тоже сразу
  await tx`delete from keys.chat_keys where chat_id = ${chatId}`;
  await enqueue(tx, 'search.purgeChat', { chatId, below: null }, { dedupeKey: `search.purgeChat:${chatId}:all` });
  await dropPersonalChannel(tx, chatId);
  // зрители превью (не участники: им не придёт chatRemoved) — после коммита кадр «чата нет» в топик чата: клиент
  // убирает чат у себя, без syncChat (на канале в 200 000 онлайн — ни одного чтения журнала); участникам chatRemoved — от chat.purge
  const [cs] = await tx`select seq from chat_seq where chat_id = ${chatId}`;
  const seq = Number(cs?.seq ?? 0);
  await tx`select pg_notify('chat_updates', ${JSON.stringify({ c: chatId, f: seq, t: seq, g: 1 } satisfies ChatNotify)})`;
  if (c?.linked_chat_id != null) {   // связанный канал или группа отвязывается
    await tx`update chats set linked_chat_id = null where id = ${c.linked_chat_id} and linked_chat_id = ${chatId}`;
    await broadcastGroup(tx, Number(c.linked_chat_id));
  }
  await enqueue(tx, 'chat.purge', { chatId, after: 0 }, { dedupeKey: `chat.purge:${chatId}:m:0` });
}

/**
 * Замки строк chats чата и связанного (канал ↔ группа обсуждения) — одним select по возрастанию id, до любых
 * других замков: тот же порядок, что у setLinkedChat. Связь могли поменять между чтением и замком — тогда откат
 * к точке сохранения (замки отпускаются) и заново, а не новые замки поверх старых.
 */
async function lockWithLinked(tx: Tx, chatId: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const ok = await tx.savepoint(async (sp) => {
      const [c0] = await sp`select linked_chat_id from chats where id = ${chatId}`;
      if (!c0) return true;   // чата нет — дальше groupCtx ответит not_member
      const linked = c0.linked_chat_id == null ? null : Number(c0.linked_chat_id);
      const ids = [...new Set([chatId, linked].filter((x): x is number => x != null))].sort((a, b) => a - b);
      await sp`select id from chats where id = any(${ids}::bigint[]) order by id for update`;
      const [c1] = await sp`select linked_chat_id from chats where id = ${chatId}`;
      if ((c1.linked_chat_id == null ? null : Number(c1.linked_chat_id)) === linked) return true;
      throw new RetryLock();
    }).catch((e) => { if (e instanceof RetryLock) return false; throw e; });
    if (ok) return;
    if (attempt >= 2) throw new DomainError('flood', 'linked', 1);
  }
}
class RetryLock extends Error {}

/** Удалить группу или канал у всех (владелец). */
export async function deleteGroup(userId: number, chatId: number): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    await lockWithLinked(tx, chatId);
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isCommunity(ctx);
    if (ctx.role !== 'owner') throw new DomainError('forbidden', 'owner');
    await deleteGroupTx(tx, chatId);
    return { ok: true };
  });
}

/**
 * Группа обсуждения канала (groupId null — отвязать). Владелец канала и админ группы с правом info. Замки строк
 * chats обоих (и прежней группы) — по возрастанию id; группа, уже привязанная к другому каналу, — forbidden.
 * Скрытая история группы выключается (и не включается, пока группа привязана). groupUpdated — всем затронутым.
 */
export async function setLinkedChat(userId: number, channelId: number, groupId: number | null): Promise<{ ok: true }> {
  if (groupId != null && (!Number.isSafeInteger(groupId) || groupId <= 0)) throw new DomainError('bad_frame', 'groupId');
  return sql.begin(async (tx) => {
    let prev: number | null = null;
    for (let attempt = 0; ; attempt++) {
      // прежняя группа — читаем без замка, запираем всё по порядку и сверяем: связь могли поменять между чтением и
      // замком — тогда откат к точке сохранения (её замки отпускаются) и заново, без новых замков поверх старых
      const ok = await tx.savepoint(async (sp) => {
        const [c0] = await sp`select linked_chat_id from chats where id = ${channelId}`;
        if (!c0) throw new DomainError('not_found', 'chat');
        prev = c0.linked_chat_id == null ? null : Number(c0.linked_chat_id);
        const ids = [...new Set([channelId, groupId, prev].filter((x): x is number => x != null))].sort((a, b) => a - b);
        await sp`select id from chats where id = any(${ids}::bigint[]) order by id for update`;
        const [c1] = await sp`select linked_chat_id from chats where id = ${channelId}`;
        if ((c1.linked_chat_id == null ? null : Number(c1.linked_chat_id)) === prev) return true;
        throw new RetryLock();
      }).catch((e) => { if (e instanceof RetryLock) return false; throw e; });
      if (ok) break;
      if (attempt >= 2) throw new DomainError('flood', 'linked', 1);   // связь меняют одновременно — повторить
    }
    const ch = await groupCtx(tx, channelId, userId);
    if (ch.kind !== 'channel') throw new DomainError('bad_frame', 'not a channel');
    if (ch.role !== 'owner') throw new DomainError('forbidden', 'owner');
    if (groupId != null) {
      const g = await groupCtx(tx, groupId, userId);
      isGroup(g);
      if (!hasAdmin(g, 'info')) throw new DomainError('forbidden', 'info');
      const [gr] = await tx`select linked_chat_id from chats where id = ${groupId}`;
      if (gr.linked_chat_id != null && Number(gr.linked_chat_id) !== channelId) throw new DomainError('forbidden', 'linked');
    }
    if (prev === groupId) return { ok: true };
    if (prev != null) await tx`update chats set linked_chat_id = null where id = ${prev}`;
    await tx`update chats set linked_chat_id = ${groupId} where id = ${channelId}`;
    if (groupId != null) await tx`update chats set linked_chat_id = ${channelId}, history_hidden = false where id = ${groupId}`;
    for (const id of [channelId, groupId, prev].filter((x): x is number => x != null).sort((a, b) => a - b)) await broadcastGroup(tx, id);
    return { ok: true };
  });
}

/** Группы, которые можно сделать обсуждением канала: мои, где я админ с info (или владелец), ни к чему не привязаны. */
export async function discussionCandidates(userId: number, channelId: number): Promise<{ groups: { id: number; title: string; photo: ProfilePhoto | null; members: number }[] }> {
  const ch = await groupCtx(sql, channelId, userId);
  if (ch.kind !== 'channel') throw new DomainError('bad_frame', 'not a channel');
  if (!hasAdmin(ch, 'info')) throw new DomainError('forbidden', 'info');
  const rows = await sql`
    select c.id, c.title, c.photo, c.members_count from chat_members m join chats c on c.id = m.chat_id
     where m.user_id = ${userId} and c.kind = 'group' and c.deleted_at is null and c.linked_chat_id is null
       and (m.role = 'owner' or (m.role = 'admin' and coalesce((m.admin_rights->>'info')::boolean, false)))
     order by c.id desc limit 200`;
  return { groups: rows.map((r) => ({ id: Number(r.id), title: (r.title as string | null) ?? '', photo: (r.photo as ProfilePhoto | null) ?? null, members: Number(r.members_count) })) };
}

export { hasAdmin };
