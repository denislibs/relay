// Управление группой внутри правой панели (как Management в Telegram Web A): стек экранов, каждый знает родителя.
// Порядок — глубина: экран дальше в списке выезжает справа поверх того, что ближе к началу.
// Только маршруты — в основном бандле (Info.tsx); сами экраны (Manage.tsx) — чанком, по первому открытию.

export const GROUP_PAGES = [
  'gEdit', 'gType', 'gReactions', 'gPerms', 'gBanned', 'gBanPick', 'gExceptionPick', 'gException',
  'gAdmins', 'gAdminPick', 'gAdminRights', 'gMembers', 'gAddMembers', 'gRequests', 'gInvites', 'gInvite', 'gInviteInfo', 'gDiscussion',
] as const;
export type GroupPage = (typeof GROUP_PAGES)[number];

const PARENT: Record<GroupPage, GroupPage | 'info'> = {
  gEdit: 'info', gType: 'gEdit', gReactions: 'gEdit', gPerms: 'gEdit', gBanned: 'gPerms', gBanPick: 'gBanned',
  gExceptionPick: 'gPerms', gException: 'gPerms', gAdmins: 'gEdit', gAdminPick: 'gAdmins', gAdminRights: 'gAdmins',
  gMembers: 'gEdit', gAddMembers: 'gMembers', gRequests: 'gEdit', gInvites: 'gEdit', gInvite: 'gInvites', gInviteInfo: 'gInvites', gDiscussion: 'gEdit',
};
export const parentOf = (p: GroupPage) => PARENT[p];
export const isGroupPage = (p: string): p is GroupPage => (GROUP_PAGES as readonly string[]).includes(p);

export type Params = { userId?: number; inviteId?: number; fresh?: boolean };
export type Nav = { chatId: number; params: Params; go: (p: GroupPage, params?: Params) => void; back: () => void; close: () => void };
