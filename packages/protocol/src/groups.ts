// Группы: права, настройки и участники. Общие для сервера и клиента — проверка одна и та же.
import type { ProfilePhoto } from './index';

type Id = number;

/** Права участников (что разрешено). Медиа — производное: разрешено, если разрешён хоть один медиа-пункт. */
export type MemberRight = 'text' | 'photos' | 'videos' | 'files' | 'music' | 'voice' | 'round' | 'stickers' | 'links' | 'react' | 'invite' | 'pin' | 'info';
export type MemberRights = Record<MemberRight, boolean>;
export const MEMBER_RIGHTS: readonly MemberRight[] = ['text', 'photos', 'videos', 'files', 'music', 'voice', 'round', 'stickers', 'links', 'react', 'invite', 'pin', 'info'];
export const MEDIA_RIGHTS: readonly MemberRight[] = ['photos', 'videos', 'files', 'music', 'voice', 'round', 'stickers', 'links'];

/** Права администратора. Владелец имеет все неявно. */
export type AdminRight = 'info' | 'delete' | 'ban' | 'invite' | 'pin' | 'addAdmins';
export type AdminRights = Record<AdminRight, boolean>;
export const ADMIN_RIGHTS: readonly AdminRight[] = ['info', 'delete', 'ban', 'invite', 'pin', 'addAdmins'];

export type GroupRole = 'owner' | 'admin' | 'member';
export type ReactionsMode = 'all' | 'some' | 'none';
export interface GroupReactions { mode: ReactionsMode; allowed: string[] }

/** Медленный режим, секунды (0 — выключен). */
export const SLOW_MODES: readonly number[] = [0, 10, 30, 60, 300, 900, 3600];
export const GROUP_ABOUT_MAX = 255;
export const RANK_MAX = 16;
export const INVITE_USAGE_MAX = 99999;

export interface GroupInfo {
  title: string;
  about: string;
  photo: ProfilePhoto | null;
  ownerId: Id | null;
  rights: MemberRights;
  slowMode: number;
  historyHidden: boolean;
  joinApproval: boolean;
  username: string | null;
  reactions: GroupReactions;
  protected: boolean;
  members: number;
  requests: number;   // заявок на вступление (видят те, кто может их принимать; остальным 0)
}

/** Моё место в группе. rights — что мне можно как участнику (исключение или умолчания). */
export interface MyMembership {
  role: GroupRole;
  admin: AdminRights | null;   // у владельца — все
  rank: string | null;
  rights: MemberRights;
  restricted: boolean;         // для меня есть исключение
}

export interface GroupMember {
  userId: Id;
  name: string;
  username: string | null;
  photo: ProfilePhoto | null;
  online: boolean | null;   // null — скрыто приватностью
  lastSeen: string | null;
  role: GroupRole;
  rank: string | null;
  admin: AdminRights | null;
  promotedBy: Id | null;
  restricted: MemberRights | null;
  inviterId: Id | null;
  joinedAt: string;
}

export interface BannedMember { userId: Id; name: string; photo: ProfilePhoto | null; bannedBy: Id | null; bannedByName: string | null; at: string }

export interface GroupInvite {
  id: Id;
  link: string;          // токен; полная ссылка — origin + '/+' + токен
  title: string | null;
  creatorId: Id | null;
  creatorName: string | null;
  expiresAt: string | null;
  usageLimit: number | null;
  usage: number;
  requests: number;
  approval: boolean;
  revoked: boolean;
  primary: boolean;
  createdAt: string;
}

export interface JoinRequest { userId: Id; name: string; photo: ProfilePhoto | null; about: string | null; at: string; inviteId: Id | null }

/** Превью приглашения (GET /join/:token): видно и не участнику. */
export interface InvitePreview { chatId: Id; title: string; about: string; photo: ProfilePhoto | null; members: number; approval: boolean; member: boolean; requested: boolean }

export const allRights = (): MemberRights => Object.fromEntries(MEMBER_RIGHTS.map((r) => [r, true])) as MemberRights;
export const allAdminRights = (): AdminRights => Object.fromEntries(ADMIN_RIGHTS.map((r) => [r, true])) as AdminRights;
export const noAdminRights = (): AdminRights => Object.fromEntries(ADMIN_RIGHTS.map((r) => [r, false])) as AdminRights;

/** Из чего угодно — полный набор прав; превью ссылок без текста не бывает. */
export function normalizeRights(raw: unknown, base: MemberRights = allRights()): MemberRights {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const r = Object.fromEntries(MEMBER_RIGHTS.map((k) => [k, typeof o[k] === 'boolean' ? o[k] : base[k]])) as MemberRights;
  if (!r.text) r.links = false;
  return r;
}

export function normalizeAdminRights(raw: unknown): AdminRights {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return Object.fromEntries(ADMIN_RIGHTS.map((k) => [k, o[k] === true])) as AdminRights;
}

/** Исключение не шире умолчаний: запрещённое для всех запрещено и ему. */
export const narrowRights = (own: MemberRights, defaults: MemberRights): MemberRights =>
  normalizeRights(Object.fromEntries(MEMBER_RIGHTS.map((k) => [k, own[k] && defaults[k]])));

export const hasMedia = (r: MemberRights) => MEDIA_RIGHTS.some((k) => r[k]);
/** Сколько прав разрешено (для подписи «Разрешения N/M»). */
export const rightsCount = (r: MemberRights) => MEMBER_RIGHTS.filter((k) => r[k]).length;

/** Какое право нужно, чтобы отправить сообщение этого вида (видео, присланное файлом, — тоже видео). */
export function rightForKind(kind: string, mime?: string | null): MemberRight {
  switch (kind) {
    case 'photo': return 'photos';
    case 'video': return 'videos';
    case 'voice': return 'voice';
    case 'round': return 'round';
    case 'audio': return 'music';
    case 'sticker': return 'stickers';
    case 'file': return mime?.startsWith('video/') ? 'videos' : 'files';
    default: return 'text';
  }
}

export const isAdminRole = (role: GroupRole) => role === 'owner' || role === 'admin';
