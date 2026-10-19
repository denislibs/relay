import { EditGroup, GroupType } from './EditGroup';
import { Banned, Exception, MemberPick, Permissions } from './Permissions';
import { AdminRightsPage, Admins } from './Admins';
import { AddMembers, ManageMembers } from './Members';
import { InviteEdit, InviteInfo, Invites, Requests } from './Invites';
import { Reactions } from './Reactions';

// Управление группой внутри правой панели (как Management в Telegram Web A): стек экранов, каждый знает родителя.
// Порядок — глубина: экран дальше в списке выезжает справа поверх того, что ближе к началу.

export const GROUP_PAGES = [
  'gEdit', 'gType', 'gReactions', 'gPerms', 'gBanned', 'gBanPick', 'gExceptionPick', 'gException',
  'gAdmins', 'gAdminPick', 'gAdminRights', 'gMembers', 'gAddMembers', 'gRequests', 'gInvites', 'gInvite', 'gInviteInfo',
] as const;
export type GroupPage = (typeof GROUP_PAGES)[number];

const PARENT: Record<GroupPage, GroupPage | 'info'> = {
  gEdit: 'info', gType: 'gEdit', gReactions: 'gEdit', gPerms: 'gEdit', gBanned: 'gPerms', gBanPick: 'gBanned',
  gExceptionPick: 'gPerms', gException: 'gPerms', gAdmins: 'gEdit', gAdminPick: 'gAdmins', gAdminRights: 'gAdmins',
  gMembers: 'gEdit', gAddMembers: 'gMembers', gRequests: 'gEdit', gInvites: 'gEdit', gInvite: 'gInvites', gInviteInfo: 'gInvites',
};
export const parentOf = (p: GroupPage) => PARENT[p];
export const isGroupPage = (p: string): p is GroupPage => (GROUP_PAGES as readonly string[]).includes(p);

export type Params = { userId?: number; inviteId?: number; fresh?: boolean };
export type Nav = { chatId: number; params: Params; go: (p: GroupPage, params?: Params) => void; back: () => void; close: () => void };

export function GroupScreen({ page, nav }: { page: GroupPage; nav: Nav }) {
  switch (page) {
    case 'gEdit': return <EditGroup nav={nav} />;
    case 'gType': return <GroupType nav={nav} />;
    case 'gReactions': return <Reactions nav={nav} />;
    case 'gPerms': return <Permissions nav={nav} />;
    case 'gBanned': return <Banned nav={nav} />;
    case 'gBanPick': return <MemberPick nav={nav} mode="ban" />;
    case 'gExceptionPick': return <MemberPick nav={nav} mode="exception" />;
    case 'gException': return <Exception nav={nav} />;
    case 'gAdmins': return <Admins nav={nav} />;
    case 'gAdminPick': return <MemberPick nav={nav} mode="admin" />;
    case 'gAdminRights': return <AdminRightsPage nav={nav} />;
    case 'gMembers': return <ManageMembers nav={nav} />;
    case 'gAddMembers': return <AddMembers nav={nav} />;
    case 'gRequests': return <Requests nav={nav} />;
    case 'gInvites': return <Invites nav={nav} />;
    case 'gInvite': return <InviteEdit nav={nav} />;
    case 'gInviteInfo': return <InviteInfo nav={nav} />;
  }
}
