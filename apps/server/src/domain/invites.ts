import { INVITE_USAGE_MAX, type GroupInvite, type InvitePreview, type JoinRequest } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { acceptMember } from './groups';
import { broadcastGroup, groupCtx, hasAdmin, requireAdmin } from './groupRights';

// Ссылки-приглашения и заявки (как в Telegram): основная ссылка группы, дополнительные со сроком и лимитом,
// отзыв, «кто вступил», одобрение вступающих. Вступление по юзернейму публичной группы — тем же путём.
// Каналы — тем же путём; вступление в канал — без служебного и groupUpdated (acceptMember).

type Db = Tx | typeof sql;
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url');

const INVITE_COLS = sql`
  i.id, i.token, i.title, i.creator_id, cu.name as creator_name, i.expires_at, i.usage_limit, i.usage, i.approval, i.revoked, i.primary_link, i.created_at,
  (select count(*)::int from chat_join_requests r where r.invite_id = i.id) as requests`;

const toInvite = (r: Record<string, unknown>): GroupInvite => ({
  id: Number(r.id),
  link: r.token as string,
  title: (r.title as string | null) ?? null,
  creatorId: r.creator_id == null ? null : Number(r.creator_id),
  creatorName: (r.creator_name as string | null) ?? null,
  expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : null,
  usageLimit: r.usage_limit == null ? null : Number(r.usage_limit),
  usage: Number(r.usage),
  requests: Number(r.requests ?? 0),
  approval: !!r.approval,
  revoked: !!r.revoked,
  primary: !!r.primary_link,
  createdAt: new Date(r.created_at as string).toISOString(),
});

/** Основная ссылка: создаётся при первом обращении. */
async function primaryInvite(tx: Tx, chatId: number, creatorId: number): Promise<void> {
  const [p] = await tx`select 1 from chat_invites where chat_id = ${chatId} and primary_link and not revoked`;
  if (!p) await tx`insert into chat_invites (chat_id, token, creator_id, primary_link) values (${chatId}, ${token()}, ${creatorId}, true)`;
}

export async function listInvites(userId: number, chatId: number): Promise<{ invites: GroupInvite[] }> {
  return sql.begin(async (tx) => {
    requireAdmin(await groupCtx(tx, chatId, userId), 'invite');
    await primaryInvite(tx, chatId, userId);
    const rows = await tx`select ${INVITE_COLS} from chat_invites i left join users cu on cu.id = i.creator_id where i.chat_id = ${chatId} order by i.id desc limit 500`;
    return { invites: rows.map(toInvite) };
  });
}

function inviteFields(body: Record<string, unknown>): { title: string | null; expiresAt: Date | null; usageLimit: number | null; approval: boolean } {
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 32) : null;
  let expiresAt: Date | null = null;
  if (body.expiresAt != null) {
    expiresAt = new Date(String(body.expiresAt));
    if (Number.isNaN(expiresAt.getTime())) throw new DomainError('bad_frame', 'expiresAt');
  }
  const approval = body.approval === true;
  let usageLimit: number | null = null;
  if (!approval && body.usageLimit != null) {
    usageLimit = Number(body.usageLimit);
    if (!Number.isInteger(usageLimit) || usageLimit < 1 || usageLimit > INVITE_USAGE_MAX) throw new DomainError('bad_frame', 'usageLimit');
  }
  return { title, expiresAt, usageLimit, approval };
}

export async function createInvite(userId: number, chatId: number, body: Record<string, unknown>): Promise<GroupInvite> {
  const f = inviteFields(body);
  if (f.expiresAt && f.expiresAt.getTime() < Date.now()) throw new DomainError('bad_frame', 'expiresAt');
  return sql.begin(async (tx) => {
    requireAdmin(await groupCtx(tx, chatId, userId), 'invite');
    const [r] = await tx`insert into chat_invites (chat_id, token, creator_id, title, expires_at, usage_limit, approval)
      values (${chatId}, ${token()}, ${userId}, ${f.title}, ${f.expiresAt}, ${f.usageLimit}, ${f.approval}) returning id`;
    return oneInvite(tx, chatId, Number(r.id));
  });
}

async function oneInvite(db: Db, chatId: number, id: number): Promise<GroupInvite> {
  const [r] = await db`select ${INVITE_COLS} from chat_invites i left join users cu on cu.id = i.creator_id where i.chat_id = ${chatId} and i.id = ${id}`;
  if (!r) throw new DomainError('not_found', 'invite');
  return toInvite(r);
}

/** Правка (не основной и не отозванной) или отзыв ({revoked: true}). Отзыв основной — сразу новая основная. */
export async function editInvite(userId: number, chatId: number, id: number, body: Record<string, unknown>): Promise<GroupInvite> {
  return sql.begin(async (tx) => {
    requireAdmin(await groupCtx(tx, chatId, userId), 'invite');
    const [i] = await tx`select primary_link, revoked from chat_invites where chat_id = ${chatId} and id = ${id} for update`;
    if (!i) throw new DomainError('not_found', 'invite');
    if (body.revoked === true) {
      await tx`update chat_invites set revoked = true where id = ${id}`;
      await tx`delete from chat_join_requests where invite_id = ${id}`;
      if (i.primary_link) await primaryInvite(tx, chatId, userId);
      await broadcastGroup(tx, chatId);
      return oneInvite(tx, chatId, id);
    }
    if (i.primary_link || i.revoked) throw new DomainError('forbidden', 'invite');
    const f = inviteFields(body);
    await tx`update chat_invites set title = ${f.title}, expires_at = ${f.expiresAt}, usage_limit = ${f.usageLimit}, approval = ${f.approval} where id = ${id}`;
    return oneInvite(tx, chatId, id);
  });
}

/** Удалить отозванную ссылку (id) или все отозванные (id = null). */
export async function deleteInvites(userId: number, chatId: number, id: number | null): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    requireAdmin(await groupCtx(tx, chatId, userId), 'invite');
    if (id == null) await tx`delete from chat_invites where chat_id = ${chatId} and revoked`;
    else {
      const del = await tx`delete from chat_invites where chat_id = ${chatId} and id = ${id} and revoked returning 1`;
      if (!del.length) throw new DomainError('forbidden', 'not revoked');
    }
    return { ok: true };
  });
}

/** Кто вступил по ссылке и кто ждёт одобрения. */
export async function inviteJoined(userId: number, chatId: number, id: number): Promise<{ joined: { userId: number; name: string; photo: unknown; at: string }[]; requests: JoinRequest[] }> {
  requireAdmin(await groupCtx(sql, chatId, userId), 'invite');
  await oneInvite(sql, chatId, id);
  const joined = await sql`select u.id, u.name, u.photo, j.at from chat_invite_joins j join users u on u.id = j.user_id where j.invite_id = ${id} order by j.at desc limit 500`;
  const reqs = await requestRows(sql, chatId, id);
  return { joined: joined.map((r) => ({ userId: Number(r.id), name: r.name as string, photo: r.photo ?? null, at: new Date(r.at as string).toISOString() })), requests: reqs };
}

async function requestRows(db: Db, chatId: number, inviteId?: number): Promise<JoinRequest[]> {
  const rows = await db`
    select u.id, u.name, u.photo, u.bio, r.at, r.invite_id from chat_join_requests r join users u on u.id = r.user_id
     where r.chat_id = ${chatId} ${inviteId ? db`and r.invite_id = ${inviteId}` : db``} order by r.at desc limit 500`;
  return rows.map((r) => ({ userId: Number(r.id), name: r.name as string, photo: (r.photo as JoinRequest['photo']) ?? null, about: (r.bio as string | null) ?? null, at: new Date(r.at as string).toISOString(), inviteId: r.invite_id == null ? null : Number(r.invite_id) }));
}

export async function listRequests(userId: number, chatId: number): Promise<{ requests: JoinRequest[] }> {
  requireAdmin(await groupCtx(sql, chatId, userId), 'invite');
  return { requests: await requestRows(sql, chatId) };
}

/** Принять или отклонить заявку (target = null — все). */
export async function decideRequests(userId: number, chatId: number, target: number | null, approve: boolean): Promise<{ ok: true }> {
  return sql.begin(async (tx) => {
    requireAdmin(await groupCtx(tx, chatId, userId, { lock: true }), 'invite');
    const rows = await tx`select user_id, invite_id from chat_join_requests where chat_id = ${chatId} ${target != null ? tx`and user_id = ${target}` : tx``}`;
    if (target != null && !rows.length) throw new DomainError('not_found', 'request');
    for (const r of rows) {
      if (approve) {
        if (await acceptMember(tx, chatId, Number(r.user_id), userId, 'joined_by_request') && r.invite_id != null) {
          await tx`insert into chat_invite_joins (invite_id, user_id, via_request) values (${r.invite_id}, ${r.user_id}, true) on conflict do nothing`;
        }
      }
    }
    await tx`delete from chat_join_requests where chat_id = ${chatId} ${target != null ? tx`and user_id = ${target}` : tx``}`;
    await broadcastGroup(tx, chatId);
    return { ok: true };
  });
}

type Target = { chatId: number; inviteId: number | null; approval: boolean; live: boolean };

/** Что открывает ссылка: «+токен» — приглашение, «@имя» — публичная группа или канал. Удалённый (мягко) — нет. */
async function resolve(db: Db, key: string): Promise<Target> {
  if (key.startsWith('@')) {
    const [c] = await db`select id, join_approval from chats where kind in ('group', 'channel') and deleted_at is null and lower(username) = lower(${key.slice(1)})`;
    if (!c) throw new DomainError('not_found', 'group');
    return { chatId: Number(c.id), inviteId: null, approval: !!c.join_approval, live: true };
  }
  const [i] = await db`select i.id, i.chat_id, i.approval, i.revoked, i.expires_at, i.usage_limit, i.usage, i.primary_link, c.join_approval
                         from chat_invites i join chats c on c.id = i.chat_id and c.deleted_at is null where i.token = ${key}`;
  if (!i) throw new DomainError('not_found', 'invite');
  const live = !i.revoked && (!i.expires_at || new Date(i.expires_at as string).getTime() > Date.now()) && (i.usage_limit == null || Number(i.usage) < Number(i.usage_limit));
  return { chatId: Number(i.chat_id), inviteId: Number(i.id), approval: !!i.approval || (!!i.join_approval && !!i.primary_link), live };
}

export async function previewInvite(userId: number, key: string): Promise<InvitePreview> {
  const t = await resolve(sql, key);
  if (!t.live) throw new DomainError('not_found', 'expired');
  const [c] = await sql`
    select c.kind, c.title, c.about, c.photo, c.members_count as members,
           exists (select 1 from chat_members m where m.chat_id = c.id and m.user_id = ${userId}) as member,
           exists (select 1 from chat_join_requests r where r.chat_id = c.id and r.user_id = ${userId}) as requested
      from chats c where c.id = ${t.chatId}`;
  return { chatId: t.chatId, kind: c.kind === 'channel' ? 'channel' : 'group', title: (c.title as string) ?? '', about: (c.about as string | null) ?? '', photo: (c.photo as InvitePreview['photo']) ?? null, members: Number(c.members), approval: t.approval, member: !!c.member, requested: !!c.requested };
}

/** Вступить по ссылке. С одобрением — заявка (requested). Удалённым из группы — нельзя. */
export async function joinByInvite(userId: number, key: string): Promise<{ chatId: number; requested: boolean }> {
  return sql.begin(async (tx) => {
    const t = await resolve(tx, key);
    if (!t.live) throw new DomainError('not_found', 'expired');
    const [c] = await tx`select deleted_at from chats where id = ${t.chatId} for update`;
    if (!c || c.deleted_at) throw new DomainError('not_found', 'group');
    const [m] = await tx`select 1 from chat_members where chat_id = ${t.chatId} and user_id = ${userId}`;
    if (m) return { chatId: t.chatId, requested: false };
    const [ban] = await tx`select 1 from chat_bans where chat_id = ${t.chatId} and user_id = ${userId}`;
    if (ban) throw new DomainError('forbidden', 'banned');
    const [sys] = await tx`select 1 from users where id = ${userId} and system`;
    if (sys) throw new DomainError('forbidden');
    if (t.approval) {
      await tx`insert into chat_join_requests (chat_id, user_id, invite_id) values (${t.chatId}, ${userId}, ${t.inviteId}) on conflict (chat_id, user_id) do nothing`;
      await broadcastGroup(tx, t.chatId);
      return { chatId: t.chatId, requested: true };
    }
    await acceptMember(tx, t.chatId, userId, null, 'joined_by_link');
    if (t.inviteId != null) {
      await tx`update chat_invites set usage = usage + 1 where id = ${t.inviteId}`;
      await tx`insert into chat_invite_joins (invite_id, user_id) values (${t.inviteId}, ${userId}) on conflict do nothing`;
    }
    return { chatId: t.chatId, requested: false };
  });
}

export { hasAdmin };
