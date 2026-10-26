import { EditGroup, GroupType } from './EditGroup';
import { Banned, Exception, MemberPick, Permissions } from './Permissions';
import { AdminRightsPage, Admins } from './Admins';
import { AddMembers, ManageMembers } from './Members';
import { InviteEdit, InviteInfo, Invites, Requests } from './Invites';
import { Reactions } from './Reactions';
import { Discussion } from './Discussion';
import type { GroupPage, Nav } from './routes';

export { GROUP_PAGES, isGroupPage, parentOf, type GroupPage, type Nav, type Params } from './routes';

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
    case 'gDiscussion': return <Discussion nav={nav} />;
  }
}
