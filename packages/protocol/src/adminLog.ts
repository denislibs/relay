// Журнал действий админов («Недавние действия»): общие для сервера и клиента типы действий, группы фильтра и формат записи.
import type { GroupReactions, MemberRights, AdminRights } from './groups';
import type { ProfilePhoto } from './index';

/** Срок хранения, часы: как в Telegram. Старше — не отдаётся, даже если задача очистки ещё не дошла. */
export const ADMIN_LOG_RETENTION_HOURS = 48;
export const ADMIN_LOG_PAGE_MAX = 100;

/** Группы фильтра → действия. Порядок — как на экране фильтра. */
export const ADMIN_LOG_GROUPS = {
  members: ['member_added', 'member_joined', 'member_left', 'member_banned', 'member_unbanned', 'member_restricted', 'member_unrestricted', 'request_approved', 'request_declined'],
  admins: ['admin_promoted', 'admin_edited', 'admin_demoted', 'admin_rank_changed', 'owner_transferred'],
  settings: ['title_changed', 'about_changed', 'photo_changed', 'photo_removed', 'username_changed', 'signatures_toggled', 'protected_toggled', 'theme_changed', 'auto_delete_changed', 'slow_mode_changed', 'history_toggled', 'join_approval_toggled', 'join_to_send_toggled', 'linked_chat_changed', 'reactions_changed', 'default_rights_changed'],
  messages: ['message_deleted', 'message_edited', 'message_pinned', 'message_unpinned', 'all_unpinned', 'poll_closed'],
  invites: ['invite_created', 'invite_edited', 'invite_revoked', 'invite_deleted'],
} as const;
export type AdminLogGroup = keyof typeof ADMIN_LOG_GROUPS;
export type AdminLogAction = (typeof ADMIN_LOG_GROUPS)[AdminLogGroup][number];
export const ADMIN_LOG_ACTIONS = Object.values(ADMIN_LOG_GROUPS).flat() as AdminLogAction[];

/** Названия типов: поиск q по типам (сервер) и подписи в фильтре (клиент) — одно и то же. */
export const ADMIN_LOG_LABELS: Record<AdminLogAction, string> = {
  member_added: 'Добавление участника', member_joined: 'Вступление', member_left: 'Выход', member_banned: 'Исключение', member_unbanned: 'Снятие исключения',
  member_restricted: 'Ограничение участника', member_unrestricted: 'Снятие ограничений', request_approved: 'Заявка одобрена', request_declined: 'Заявка отклонена',
  admin_promoted: 'Назначение администратора', admin_edited: 'Изменение прав администратора', admin_demoted: 'Снятие администратора', admin_rank_changed: 'Изменение звания', owner_transferred: 'Передача владения',
  title_changed: 'Название', about_changed: 'Описание', photo_changed: 'Фото', photo_removed: 'Удаление фото', username_changed: 'Адрес', signatures_toggled: 'Подписи постов',
  protected_toggled: 'Защита содержимого', theme_changed: 'Тема чата', auto_delete_changed: 'Автоудаление', slow_mode_changed: 'Медленный режим', history_toggled: 'История для новых участников',
  join_approval_toggled: 'Вступление по заявке', join_to_send_toggled: 'Только участники пишут', linked_chat_changed: 'Группа обсуждения', reactions_changed: 'Реакции', default_rights_changed: 'Права участников',
  message_deleted: 'Удаление сообщения', message_edited: 'Правка сообщения', message_pinned: 'Закрепление', message_unpinned: 'Открепление', all_unpinned: 'Открепление всех', poll_closed: 'Закрытие опроса',
  invite_created: 'Создание ссылки', invite_edited: 'Изменение ссылки', invite_revoked: 'Отзыв ссылки', invite_deleted: 'Удаление ссылки',
};

type Id = number;
type Change<T> = { from: T; to: T };
type Toggle = { on: boolean };
type Target = { target: Id };
/** Сообщение — только ссылкой: автор, id. Тексты не копируются никогда. */
type MessageRef = { messageId: Id; target?: Id };
export type InviteFields = { title: string | null; expiresAt: string | null; usageLimit: number | null; approval: boolean };
type InviteRef = { inviteId: Id; mask: string };
export type ThemeRef = { emoji: string; title: string } | null;

/** Что лежит в admin_log.data по каждому действию. */
export interface AdminLogData {
  title_changed: Change<string>; about_changed: Change<string>; photo_changed: Record<string, never>; photo_removed: Record<string, never>;
  username_changed: Change<string | null>; signatures_toggled: Toggle; protected_toggled: Toggle; theme_changed: Change<ThemeRef>;
  auto_delete_changed: Change<number | null>; slow_mode_changed: Change<number>; history_toggled: { hidden: boolean }; join_approval_toggled: Toggle;
  join_to_send_toggled: Toggle; linked_chat_changed: Change<Id | null>; reactions_changed: Change<GroupReactions>; default_rights_changed: Change<MemberRights>;
  member_added: Target; member_joined: Target & { via: 'link' | 'username' | 'discussion'; mask?: string }; member_left: Target; member_banned: Target; member_unbanned: Target;
  member_restricted: Target & Change<MemberRights>; member_unrestricted: Target; request_approved: Target; request_declined: Target;
  admin_promoted: Target & { rights: AdminRights; rank: string | null }; admin_edited: Target & Change<AdminRights>; admin_demoted: Target;
  admin_rank_changed: Target & Change<string | null>; owner_transferred: Target & { auto?: boolean };
  message_deleted: MessageRef & { at: string }; message_edited: MessageRef; message_pinned: MessageRef; message_unpinned: MessageRef; all_unpinned: { count: number }; poll_closed: MessageRef;
  invite_created: InviteRef & InviteFields & { primary?: boolean }; invite_edited: InviteRef & Change<InviteFields>; invite_revoked: InviteRef & { title: string | null; primary?: boolean }; invite_deleted: InviteRef & { title: string | null };
}

/** Сообщение, на которое ссылается запись: есть, только если доступно этому админу тем же путём, что обычное чтение. */
export interface AdminLogMessage { id: Id; threadId?: Id; kind: string; body: string }
export interface AdminLogUser { id: Id; name: string | null; key?: string; photo: ProfilePhoto | null }
export type AdminLogEntry = {
  [A in AdminLogAction]: { id: Id; action: A; at: string; actorId: Id | null; data: AdminLogData[A] & { hidden?: boolean }; message?: AdminLogMessage | null };
}[AdminLogAction];
/** Страница: новые сверху; users — исполнители и цели (имя и фото глазами читателя, удалённый — name null); chats — связанные чаты, которые читателю можно назвать. */
export interface AdminLogPage { entries: AdminLogEntry[]; users: AdminLogUser[]; chats: { id: Id; title: string }[]; hasMore: boolean }
