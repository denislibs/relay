import {
  allAdminRights, allRights, normalizeAdminRights, normalizeRights, narrowRights,
  type AdminRight, type AdminRights, type GroupInfo, type GroupReactions, type GroupRole, type MemberRight, type MemberRights, type MyMembership, type ProfilePhoto,
} from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';

type Db = Tx | typeof sql;

/** Группа и моё место в ней — всё, что нужно для проверки прав одной операции. */
export interface GroupCtx {
  chatId: number;
  userId: number;
  kind: 'direct' | 'group';
  role: GroupRole;
  admin: AdminRights | null;      // у владельца — все
  rights: MemberRights;           // что можно мне как участнику (у админа и владельца — всё)
  restricted: MemberRights | null;
  defaults: MemberRights;
  slowMode: number;
  reactions: GroupReactions;
  protected: boolean;
  historyFrom: number;
  ownerId: number | null;
}

const reactionsOf = (raw: unknown): GroupReactions => {
  const o = raw && typeof raw === 'object' ? raw as { mode?: unknown; allowed?: unknown } : {};
  const mode = o.mode === 'some' || o.mode === 'none' ? o.mode : 'all';
  return { mode, allowed: mode === 'some' && Array.isArray(o.allowed) ? o.allowed.filter((e): e is string => typeof e === 'string').slice(0, 100) : [] };
};

/** Для записи (for update) — когда операция меняет состав или роли, чтобы параллельные не разошлись. */
export async function groupCtx(db: Db, chatId: number, userId: number, opts: { lock?: boolean } = {}): Promise<GroupCtx> {
  const [r] = await db`
    select c.kind, c.rights as chat_rights, c.slow_mode, c.reactions, c.protected, c.owner_id,
           m.role, m.admin_rights, m.restricted, m.history_from
      from chat_members m join chats c on c.id = m.chat_id
     where m.chat_id = ${chatId} and m.user_id = ${userId}
     ${opts.lock ? db`for update of c` : db``}`;
  if (!r) throw new DomainError('not_member');
  return ctxFromRow(chatId, userId, r);
}

/** Строка (chats + chat_members) → права. Колонки: kind, chat_rights, slow_mode, reactions, protected, owner_id, role, admin_rights, restricted, history_from. */
export function ctxFromRow(chatId: number, userId: number, r: Record<string, unknown>): GroupCtx {
  const kind = r.kind as 'direct' | 'group';
  const defaults = normalizeRights(r.chat_rights);
  const role: GroupRole = kind === 'group' ? (r.role as GroupRole) ?? 'member' : 'member';
  const admin = role === 'owner' ? allAdminRights() : role === 'admin' ? normalizeAdminRights(r.admin_rights) : null;
  const restricted = kind === 'group' && role === 'member' && r.restricted ? narrowRights(normalizeRights(r.restricted), defaults) : null;
  const rights = kind !== 'group' || admin ? allRights() : restricted ?? defaults;
  return {
    chatId, userId, kind, role, admin, rights, restricted, defaults,
    slowMode: kind === 'group' ? Number(r.slow_mode ?? 0) : 0,
    reactions: kind === 'group' ? reactionsOf(r.reactions) : { mode: 'all', allowed: [] },
    protected: !!r.protected,
    historyFrom: Number(r.history_from ?? 0),
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
  };
}

export function isGroup(ctx: GroupCtx): void {
  if (ctx.kind !== 'group') throw new DomainError('bad_frame', 'not a group');
}

/** Право администратора (владелец — всегда). */
export const hasAdmin = (ctx: GroupCtx, right: AdminRight) => !!ctx.admin?.[right];
export function requireAdmin(ctx: GroupCtx, right: AdminRight): void {
  isGroup(ctx);
  if (!hasAdmin(ctx, right)) throw new DomainError('forbidden', right);
}

/** Право участника: админа права участников не ограничивают. */
export const can = (ctx: GroupCtx, right: MemberRight) => ctx.rights[right];
export function requireRight(ctx: GroupCtx, right: MemberRight): void {
  if (!can(ctx, right)) throw new DomainError('forbidden', right);
}

/** Менять информацию: админ с правом или участник, которому это разрешено. */
export const canChangeInfo = (ctx: GroupCtx) => hasAdmin(ctx, 'info') || (ctx.kind === 'group' && can(ctx, 'info'));
export const canPin = (ctx: GroupCtx) => ctx.kind !== 'group' || hasAdmin(ctx, 'pin') || can(ctx, 'pin');
export const canInvite = (ctx: GroupCtx) => hasAdmin(ctx, 'invite') || (ctx.kind === 'group' && can(ctx, 'invite'));

export function myMembership(ctx: GroupCtx, rank: string | null): MyMembership {
  return { role: ctx.role, admin: ctx.admin, rank, rights: ctx.rights, restricted: !!ctx.restricted };
}

const photoOf = (raw: unknown): ProfilePhoto | null => raw && typeof raw === 'object' ? raw as ProfilePhoto : null;

/** Сводка группы. requests — только тем, кто может принимать заявки (остальным 0). */
export async function groupInfo(db: Db, chatId: number): Promise<Omit<GroupInfo, 'requests'> & { pending: number }> {
  const [c] = await db`
    select title, about, photo, owner_id, rights, slow_mode, history_hidden, join_approval, username, reactions, protected,
           (select count(*)::int from chat_members m where m.chat_id = c.id) as members,
           (select count(*)::int from chat_join_requests r where r.chat_id = c.id) as pending
      from chats c where id = ${chatId}`;
  return {
    title: (c.title as string | null) ?? '',
    about: (c.about as string | null) ?? '',
    photo: photoOf(c.photo),
    ownerId: c.owner_id == null ? null : Number(c.owner_id),
    rights: normalizeRights(c.rights),
    slowMode: Number(c.slow_mode ?? 0),
    historyHidden: !!c.history_hidden,
    joinApproval: !!c.join_approval,
    username: (c.username as string | null) ?? null,
    reactions: reactionsOf(c.reactions),
    protected: !!c.protected,
    members: Number(c.members),
    pending: Number(c.pending),
  };
}

/** Кто из участников видит заявки (админы с правом приглашать и владелец). */
async function approvers(db: Db, chatId: number): Promise<Set<number>> {
  const rows = await db`select user_id from chat_members where chat_id = ${chatId} and (role = 'owner' or (role = 'admin' and coalesce((admin_rights->>'invite')::boolean, false)))`;
  return new Set(rows.map((r) => Number(r.user_id)));
}

/** Информация группы изменилась — всем участникам (заявки — только тем, кто их принимает). */
export async function broadcastGroup(tx: Tx, chatId: number, extra: number[] = []): Promise<void> {
  const { pending, ...info } = await groupInfo(tx, chatId);
  const members = (await tx`select user_id from chat_members where chat_id = ${chatId}`).map((r) => Number(r.user_id));
  const can = await approvers(tx, chatId);
  const ids = [...new Set([...members, ...extra])];
  await appendUpdates(tx, ids.map((userId) => ({ userId, update: { type: 'groupUpdated', chatId, group: { ...info, requests: can.has(userId) ? pending : 0 } } })));
}

/** Моя роль или права изменились — только этому человеку. */
export async function sendMembership(tx: Tx, chatId: number, userId: number): Promise<void> {
  const ctx = await groupCtx(tx, chatId, userId);
  const [m] = await tx`select rank from chat_members where chat_id = ${chatId} and user_id = ${userId}`;
  await appendUpdates(tx, [{ userId, update: { type: 'membership', chatId, me: myMembership(ctx, (m?.rank as string | null) ?? null) } }]);
}

export async function membersOf(db: Db, chatId: number): Promise<number[]> {
  return (await db`select user_id from chat_members where chat_id = ${chatId}`).map((r) => Number(r.user_id));
}

/** Состав или роли изменились — всем участникам перечитать список. */
export async function broadcastMembers(tx: Tx, chatId: number): Promise<void> {
  const ids = await membersOf(tx, chatId);
  await appendUpdates(tx, ids.map((userId) => ({ userId, update: { type: 'membersChanged', chatId } })));
}

/** Сводка для списка чатов из одной строки запроса (без лишних запросов на каждую группу). */
export function summaryFromRow(chatId: number, userId: number, r: Record<string, unknown>): { group: GroupInfo; me: MyMembership } {
  const ctx = ctxFromRow(chatId, userId, r);
  return {
    group: {
      title: (r.title as string | null) ?? '',
      about: (r.about as string | null) ?? '',
      photo: photoOf(r.g_photo),
      ownerId: r.owner_id == null ? null : Number(r.owner_id),
      rights: ctx.defaults,
      slowMode: ctx.slowMode,
      historyHidden: !!r.history_hidden,
      joinApproval: !!r.join_approval,
      username: (r.username as string | null) ?? null,
      reactions: ctx.reactions,
      protected: ctx.protected,
      members: Number(r.g_members ?? 0),
      requests: hasAdmin(ctx, 'invite') ? Number(r.g_pending ?? 0) : 0,
    },
    me: myMembership(ctx, (r.rank as string | null) ?? null),
  };
}

/** Сводка для списка чатов (снимок): группа и моё место в ней. */
export async function groupSummary(db: Db, chatId: number, userId: number): Promise<{ group: GroupInfo; me: MyMembership }> {
  const ctx = await groupCtx(db, chatId, userId);
  const { pending, ...info } = await groupInfo(db, chatId);
  const [m] = await db`select rank from chat_members where chat_id = ${chatId} and user_id = ${userId}`;
  return { group: { ...info, requests: hasAdmin(ctx, 'invite') ? pending : 0 }, me: myMembership(ctx, (m?.rank as string | null) ?? null) };
}
