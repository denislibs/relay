import {
  graphemes, normalizeAdminRights, normalizeRights, narrowRights, allAdminRights, ADMIN_RIGHTS, GROUP_ABOUT_MAX, RANK_MAX, SLOW_MODES,
  type AdminRights, type BannedMember, type GroupMember, type GroupReactions, type GroupRole, type Message, type MemberRights, type ServiceData, type ServiceType,
} from '@relay/protocol';
import { sql, type Tx } from '../db';
import { GROUP_MEMBERS_MAX, GROUP_TITLE_MAX, toMessage } from './chats';
import { DomainError } from './errors';
import { appendUpdates, fanOut } from './journal';
import { nameForSql } from './profile';
import { checkPassword } from './password';
import { onlineUsers } from './liveRegistry';
import { presenceFor } from './presence';
import { privacyCtx } from './privacy';
import {
  broadcastGroup, broadcastMembers, canChangeInfo, canInvite, groupCtx, hasAdmin, isGroup, membersOf, requireAdmin, sendMembership, type GroupCtx,
} from './groupRights';

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

/** Служебное сообщение группы: в ленту всем участникам (и extra — тем, кого уже нет, чтобы увидели «вас удалили»). */
export async function serviceMessage(tx: Tx, chatId: number, senderId: number, type: ServiceType, data: ServiceData = {}, body = ''): Promise<Message> {
  const [row] = await tx`
    insert into messages (chat_id, sender_id, client_id, kind, body, service_type, service_data)
    values (${chatId}, ${senderId}, ${crypto.randomUUID()}, 'text', ${body}, ${type}, ${Object.keys(data).length ? tx.json(data as never) : null}) returning *`;
  const message = toMessage(row);
  await fanOut(tx, await membersOf(tx, chatId), { type: 'newMessage', message });
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
    isGroup(ctx);
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
    const rows = await sql`select id, width, height, mime from attachments where id = any(${[id, small]}::uuid[]) and owner_id = ${userId} and status = 'ready'`;
    const side = (x: string) => { const r = rows.find((a) => a.id === x); return r && /^image\//.test(r.mime as string) && r.width === r.height ? Number(r.width) : 0; };
    const b = side(id), s = side(small);
    if (b < 160 || b > 1280 || s < 48 || s > 320) throw bad();
    photo = { id, small, thumb };
  }
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isGroup(ctx);
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

/** История для новых, одобрение вступающих, запрет копирования, реакции. */
export async function setGroupSettings(userId: number, chatId: number, body: { historyHidden?: unknown; joinApproval?: unknown; protected?: unknown; reactions?: unknown }): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isGroup(ctx);
    const [c] = await tx`select history_hidden, join_approval, protected from chats where id = ${chatId}`;
    if (body.historyHidden !== undefined) {
      requireAdmin(ctx, 'ban');
      await tx`update chats set history_hidden = ${body.historyHidden === true} where id = ${chatId}`;
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
      const allowed = mode === 'some' && Array.isArray(o.allowed) ? [...new Set(o.allowed.filter((e): e is string => typeof e === 'string' && e.length <= 16))].slice(0, 100) : [];
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
    isGroup(ctx);
    if (ctx.role !== 'owner') throw new DomainError('forbidden', 'owner');
    if (name) {
      const [u] = await tx`select 1 from users where lower(username) = lower(${name}) union all select 1 from chats where lower(username) = lower(${name}) and id <> ${chatId} limit 1`;
      if (u) throw new DomainError('username_taken');
    }
    await tx`update chats set username = ${name ? name.toLowerCase() : null} where id = ${chatId}`;
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

/** Участники с ролями. filter: all | admins | restricted. Присутствие — по правилам приватности (presence.ts). */
export async function listGroupMembers(viewer: number, chatId: number, filter = 'all', q = ''): Promise<{ members: GroupMember[] }> {
  const ctx = await groupCtx(sql, chatId, viewer);
  isGroup(ctx);
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
      name: r.name as string,
      username: (r.username as string | null) ?? null,
      photo: (r.photo as GroupMember['photo']) ?? null,
      role: r.role as GroupRole,
      rank: (r.rank as string | null) ?? null,
      admin: r.role === 'owner' ? allAdminRights() : r.role === 'admin' ? normalizeAdminRights(r.admin_rights) : null,
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
async function insertMember(tx: Tx, chatId: number, userId: number, inviterId: number | null): Promise<boolean> {
  const [c] = await tx`select history_hidden, (select coalesce(max(id), 0) from messages where chat_id = ${chatId}) as last_id from chats where id = ${chatId}`;
  const from = c.history_hidden ? Number(c.last_id) + 1 : 0;
  const ins = await tx`insert into chat_members (chat_id, user_id, inviter_id, history_from) values (${chatId}, ${userId}, ${inviterId}, ${from}) on conflict do nothing returning 1`;
  return ins.length > 0;
}

async function memberCount(db: Db, chatId: number): Promise<number> {
  const [{ n }] = await db`select count(*)::int as n from chat_members where chat_id = ${chatId}`;
  return n;
}

/** Вступление по ссылке, юзернейму или принятой заявке: участник, служебное, всем — новый состав. */
export async function acceptMember(tx: Tx, chatId: number, userId: number, actorId: number | null, type: 'joined_by_link' | 'joined_by_request' | 'members_added'): Promise<boolean> {
  if (await memberCount(tx, chatId) >= GROUP_MEMBERS_MAX) throw new DomainError('too_long', 'members');
  if (!(await insertMember(tx, chatId, userId, actorId))) return false;
  await tx`delete from chat_join_requests where chat_id = ${chatId} and user_id = ${userId}`;
  await serviceMessage(tx, chatId, userId, type, { users: await names(tx, [userId]) });
  await sendMembership(tx, chatId, userId);
  await broadcastGroup(tx, chatId);
  await broadcastMembers(tx, chatId);
  return true;
}

/**
 * Добавить людей. Нельзя — системных, несуществующих, тех, с кем блокировка; удалённых возвращает только тот,
 * кто может блокировать (это и разблокирует). Кого нельзя добавить — в ответе (клиент предложит ссылку).
 */
export async function addGroupMembers(userId: number, chatId: number, rawIds: unknown): Promise<{ added: number[]; failed: number[] }> {
  if (!Array.isArray(rawIds)) throw new DomainError('bad_frame', 'userIds');
  const ids = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== userId))].slice(0, GROUP_MEMBERS_MAX);
  if (!ids.length) throw new DomainError('bad_frame', 'userIds');
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isGroup(ctx);
    if (!canInvite(ctx)) throw new DomainError('forbidden', 'invite');
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
      if (await memberCount(tx, chatId) >= GROUP_MEMBERS_MAX) break;
      if (banned.has(id)) await tx`delete from chat_bans where chat_id = ${chatId} and user_id = ${id}`;
      if (await insertMember(tx, chatId, id, userId)) added.push(id);
    }
    const already = new Set((await tx`select user_id from chat_members where chat_id = ${chatId} and user_id = any(${ids}::bigint[])`).map((r) => Number(r.user_id)));
    const failed = ids.filter((id) => !already.has(id));
    if (added.length) {
      await tx`delete from chat_join_requests where chat_id = ${chatId} and user_id = any(${added}::bigint[])`;
      await serviceMessage(tx, chatId, userId, 'members_added', { users: await names(tx, added) });
      for (const id of added) await sendMembership(tx, chatId, id);
      await broadcastGroup(tx, chatId);
      await broadcastMembers(tx, chatId);
    }
    return { added, failed };
  });
}

/** Убрать из группы: служебное, удалённому — chatRemoved, всем — новый состав. */
async function dropMember(tx: Tx, chatId: number, target: number, actor: number, type: 'member_left' | 'member_removed'): Promise<void> {
  await serviceMessage(tx, chatId, actor, type, { users: await names(tx, [target]) });
  await tx`delete from chat_members where chat_id = ${chatId} and user_id = ${target}`;
  await tx`delete from drafts where chat_id = ${chatId} and user_id = ${target}`;
  await appendUpdates(tx, [{ userId: target, update: { type: 'chatRemoved', chatId } }]);
  await broadcastGroup(tx, chatId);
  await broadcastMembers(tx, chatId);
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
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isGroup(ctx);
    if (target === userId) {
      if (ctx.role === 'owner') {
        // новый владелец — самый давний админ, иначе самый давний участник; никого — группа удаляется
        const [next] = await tx`select user_id from chat_members where chat_id = ${chatId} and user_id <> ${userId}
                                 order by case role when 'admin' then 0 else 1 end, joined_at limit 1`;
        if (!next) { await deleteGroupTx(tx, chatId); return { ok: true }; }
        await makeOwner(tx, chatId, Number(next.user_id), userId);
      }
      await dropMember(tx, chatId, userId, userId, 'member_left');
      return { ok: true };
    }
    requireAdmin(ctx, 'ban');
    const [t] = await tx`select role, promoted_by from chat_members where chat_id = ${chatId} and user_id = ${target}`;
    if (!t) throw new DomainError('not_found', 'member');
    if (t.role !== 'member' && !canManageAdmin(ctx, t as never)) throw new DomainError('forbidden', 'admin');
    await tx`insert into chat_bans (chat_id, user_id, banned_by) values (${chatId}, ${target}, ${userId}) on conflict (chat_id, user_id) do update set banned_by = excluded.banned_by, at = now()`;
    await dropMember(tx, chatId, target, userId, 'member_removed');
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
    requireAdmin(ctx, 'ban');
    const [t] = await tx`select role from chat_members where chat_id = ${chatId} and user_id = ${target}`;
    if (!t) throw new DomainError('not_found', 'member');
    if (t.role !== 'member') throw new DomainError('forbidden', 'admin');
    const value = raw == null ? null : narrowRights(normalizeRights(raw), ctx.defaults);
    // совпадает с умолчаниями — это не исключение
    const same = value && Object.keys(value).every((k) => value[k as keyof MemberRights] === ctx.defaults[k as keyof MemberRights]);
    await tx`update chat_members set restricted = ${value && !same ? tx.json(value as never) : null} where chat_id = ${chatId} and user_id = ${target}`;
    await sendMembership(tx, chatId, target);
    await broadcastMembers(tx, chatId);
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
      const rights: AdminRights = normalizeAdminRights(body.rights);
      for (const r of ADMIN_RIGHTS) if (rights[r] && !ctx.admin![r]) throw new DomainError('forbidden', r);
      const rank = body.rank === undefined ? undefined : validRank(body.rank);
      await tx`update chat_members set role = 'admin', admin_rights = ${tx.json(rights as never)}, restricted = null,
                 promoted_by = case when role = 'admin' then promoted_by else ${userId} end
                 ${rank !== undefined ? tx`, rank = ${rank}` : tx``}
               where chat_id = ${chatId} and user_id = ${target}`;
    }
    await sendMembership(tx, chatId, target);
    await broadcastGroup(tx, chatId);   // список тех, кто видит заявки, мог поменяться
    await broadcastMembers(tx, chatId);
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
    await broadcastMembers(tx, chatId);
    return { ok: true };
  });
}

async function makeOwner(tx: Tx, chatId: number, target: number, prev: number): Promise<void> {
  await tx`update chats set owner_id = ${target} where id = ${chatId}`;
  await tx`update chat_members set role = 'owner', admin_rights = null, restricted = null, promoted_by = null where chat_id = ${chatId} and user_id = ${target}`;
  // прежний владелец остаётся админом со всеми правами (как в Telegram)
  await tx`update chat_members set role = 'admin', admin_rights = ${tx.json(allAdminRights() as never)}, promoted_by = ${target} where chat_id = ${chatId} and user_id = ${prev}`;
  await serviceMessage(tx, chatId, prev, 'owner_changed', { users: await names(tx, [target]) });
  await sendMembership(tx, chatId, target);
  await sendMembership(tx, chatId, prev).catch(() => {});   // прежний мог уже выйти
  await broadcastGroup(tx, chatId);
  await broadcastMembers(tx, chatId);
}

/** Передать права на группу: только владелец и только с паролем 2FA (как в Telegram). */
export async function transferGroupOwnership(userId: number, chatId: number, target: number, proof: unknown): Promise<{ ok: true }> {
  const ctx = await groupCtx(sql, chatId, userId);
  isGroup(ctx);
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

async function deleteGroupTx(tx: Tx, chatId: number): Promise<void> {
  const ids = await membersOf(tx, chatId);
  await appendUpdates(tx, ids.map((uid) => ({ userId: uid, update: { type: 'chatRemoved', chatId } })));
  await tx`delete from chats where id = ${chatId}`;
}

/** Удалить группу у всех (владелец). */
export async function deleteGroup(userId: number, chatId: number): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId, { lock: true });
    isGroup(ctx);
    if (ctx.role !== 'owner') throw new DomainError('forbidden', 'owner');
    await deleteGroupTx(tx, chatId);
    return { ok: true };
  });
}

export { hasAdmin };
