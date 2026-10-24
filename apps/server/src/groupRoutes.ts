import {
  addGroupMembers, checkGroupUsername, deleteGroup, discussionCandidates, listBanned, listGroupMembers, removeGroupMember, restrictGroupMember,
  setGroupAdmin, setGroupPhoto, setGroupRank, setGroupRights, setGroupSettings, setGroupUsername, setLinkedChat, transferGroupOwnership, unbanGroupMember, updateGroupInfo,
} from './domain/groups';
import { createInvite, decideRequests, deleteInvites, editInvite, inviteJoined, joinByInvite, joinDiscussion, listInvites, listRequests, previewInvite } from './domain/invites';
import { DomainError } from './domain/errors';
import { channelPreview } from './domain/channelPreview';

// Управление группой и каналом: /groups/:id/... и вступление по ссылке /join/:key («+токен» или «@имя»). Права проверяет домен.

const body = async (req: Request): Promise<Record<string, unknown>> => {
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new DomainError('bad_frame', 'body');
  return b as Record<string, unknown>;
};
const json = (v: unknown) => Response.json(v);

export async function groupRoute(req: Request, url: URL, userId: number): Promise<Response | null> {
  const p = url.pathname, m = req.method;

  const join = /^\/join\/([+@][A-Za-z0-9_-]{1,64})$/.exec(p);
  if (join) {
    const key = join[1].startsWith('+') ? join[1].slice(1) : join[1];
    if (m === 'GET') return json(await previewInvite(userId, key));
    if (m === 'POST') return json(await joinByInvite(userId, key));
    return null;
  }
  if (m === 'GET' && p === '/groups/username/check') {
    const chat = Number(url.searchParams.get('chatId')) || undefined;
    return json(await checkGroupUsername(url.searchParams.get('username') ?? '', chat));
  }

  const g = /^\/groups\/(\d{1,15})(\/.*)?$/.exec(p);
  if (!g) return null;
  const chatId = Number(g[1]), rest = g[2] ?? '';
  let r: RegExpExecArray | null;

  if (rest === '') {
    // строка чата: участнику — его, не участнику публичного канала — превью до подписки (channelPreview.ts)
    if (m === 'GET') return json(await channelPreview(userId, chatId));
    if (m === 'PATCH') return json(await updateGroupInfo(userId, chatId, await body(req)));
    if (m === 'DELETE') return json(await deleteGroup(userId, chatId));
  }
  if (rest === '/photo') {
    if (m === 'PUT') return json(await setGroupPhoto(userId, chatId, await body(req)));
    if (m === 'DELETE') return json(await setGroupPhoto(userId, chatId, null));
  }
  if (rest === '/rights' && m === 'PUT') return json(await setGroupRights(userId, chatId, await body(req)));
  if (rest === '/settings' && m === 'PUT') return json(await setGroupSettings(userId, chatId, await body(req)));
  // канал: группа обсуждения ({groupId: null} — отвязать) и кандидаты в неё
  if (rest === '/discussion' && m === 'PUT') { const g = (await body(req)).groupId; return json(await setLinkedChat(userId, chatId, g == null ? null : Number(g))); }
  // группа обсуждения: вступить из треда (гость — подписчик канала, invites.ts joinDiscussion)
  if (rest === '/join' && m === 'POST') return json(await joinDiscussion(userId, chatId));
  if (rest === '/discussion-candidates' && m === 'GET') return json(await discussionCandidates(userId, chatId));
  if (rest === '/username' && m === 'PUT') return json(await setGroupUsername(userId, chatId, (await body(req)).username));
  if (rest === '/owner' && m === 'POST') { const b = await body(req); return json(await transferGroupOwnership(userId, chatId, Number(b.userId), b.proof)); }

  if (rest === '/members') {
    if (m === 'GET') return json(await listGroupMembers(userId, chatId, url.searchParams.get('filter') ?? 'all', url.searchParams.get('q') ?? ''));
    if (m === 'POST') return json(await addGroupMembers(userId, chatId, (await body(req)).userIds));
  }
  if ((r = /^\/members\/(\d{1,15})$/.exec(rest)) && m === 'DELETE') return json(await removeGroupMember(userId, chatId, Number(r[1])));
  if ((r = /^\/members\/(\d{1,15})\/restrict$/.exec(rest)) && m === 'PUT') return json(await restrictGroupMember(userId, chatId, Number(r[1]), (await body(req)).rights ?? null));
  if ((r = /^\/members\/(\d{1,15})\/rank$/.exec(rest)) && m === 'PUT') return json(await setGroupRank(userId, chatId, Number(r[1]), (await body(req)).rank));
  if ((r = /^\/admins\/(\d{1,15})$/.exec(rest)) && m === 'PUT') return json(await setGroupAdmin(userId, chatId, Number(r[1]), await body(req)));
  if (rest === '/bans' && m === 'GET') return json(await listBanned(userId, chatId));
  if ((r = /^\/bans\/(\d{1,15})$/.exec(rest)) && m === 'DELETE') return json(await unbanGroupMember(userId, chatId, Number(r[1])));

  if (rest === '/invites') {
    if (m === 'GET') return json(await listInvites(userId, chatId));
    if (m === 'POST') return json(await createInvite(userId, chatId, await body(req)));
    if (m === 'DELETE') return json(await deleteInvites(userId, chatId, null));   // все отозванные
  }
  if ((r = /^\/invites\/(\d{1,15})$/.exec(rest))) {
    if (m === 'PATCH') return json(await editInvite(userId, chatId, Number(r[1]), await body(req)));
    if (m === 'DELETE') return json(await deleteInvites(userId, chatId, Number(r[1])));
  }
  if ((r = /^\/invites\/(\d{1,15})\/joined$/.exec(rest)) && m === 'GET') return json(await inviteJoined(userId, chatId, Number(r[1])));

  if (rest === '/requests') {
    if (m === 'GET') return json(await listRequests(userId, chatId));
    if (m === 'POST') return json(await decideRequests(userId, chatId, null, (await body(req)).approve === true));
  }
  if ((r = /^\/requests\/(\d{1,15})$/.exec(rest)) && m === 'POST') return json(await decideRequests(userId, chatId, Number(r[1]), (await body(req)).approve === true));
  return null;
}
