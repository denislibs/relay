import { ContactPicker, Modal, SearchInput, peerTone } from '@relay/ui';
import type { GroupInvite, GroupMember } from '@relay/protocol';
import { useState } from 'preact/hooks';
import { createDirectChat, engineSend, openUserChat } from '../../data';
import { useGlobal } from '../../global';
import { act, adminCan, canInvite, inviteUrl, plural, useGroup, useGroupData } from '../../groups';
import { senderAvatar } from '../../profilePhoto';
import { showToast } from '../../settingsData';
import { isSystemChat, lastSeenText } from '../format';
import { candidates } from '../settings/privacyLogic';
import { GPage, Loading, PersonRow } from './common';
import type { Nav } from './Manage';

/** «Участники» в управлении: поиск, звания и роли, действия над участником; «+» — добавить. */
export function ManageMembers({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { me, membersRev, kind } = useGroup(chatId);
  const channel = kind === 'channel';   // подписчики: без ограничения прав (их у подписчика нет)
  const myId = useGlobal((s) => s.me!.userId);
  const all = useGroupData<{ members: GroupMember[] }>(`/groups/${chatId}/members`, membersRev);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<GroupMember | null>(null);
  const needle = q.trim().toLowerCase();
  const list = (all.data?.members ?? []).filter((m) => !needle || m.name.toLowerCase().includes(needle) || (m.username ?? '').toLowerCase().includes(needle));
  const n = all.data?.members.length ?? 0;
  const badge = (m: GroupMember) => m.rank ?? (m.role === 'owner' ? 'владелец' : m.role === 'admin' ? 'админ' : undefined);
  const canBan = adminCan(me, 'ban'), canPromote = adminCan(me, 'addAdmins');
  const open = (m: GroupMember) => {
    if (m.userId === myId) return;
    // обычному участнику действия не нужны — сразу личный чат
    if (m.role === 'member' && (canBan || canPromote)) setMenu(m);
    else { nav.close(); void openUserChat(m.userId); }   // поверх группы (docs/navigation-rules.md)
  };
  const remove = async (m: GroupMember) => { setMenu(null); await act('DELETE', `/groups/${chatId}/members/${m.userId}`, undefined, `${m.name} удалён(а) из ${channel ? 'канала' : 'группы'}`); };
  const who = channel ? 'подписчиков' : 'участников';
  return (
    <GPage title={channel ? 'Подписчики' : 'Участники'} onBack={nav.back} fab={canInvite(me) ? { show: true, icon: 'userPlus', label: 'Добавить ' + who, onClick: () => nav.go('gAddMembers') } : undefined}>
      <div class="app-gm-search"><SearchInput id="gm-members-search" label={'Поиск ' + who} value={q} placeholder={'Поиск ' + who} onInput={(e: Event) => setQ((e.currentTarget as HTMLInputElement).value)} /></div>
      <p class="app-gm-note">{n ? `${n} ${channel ? plural(n, 'подписчик', 'подписчика', 'подписчиков') : plural(n, 'участник', 'участника', 'участников')}` : ''}</p>
      <div class="app-members" role="list">
        {all.data ? list.length ? list.map((m) => (
          <PersonRow key={m.userId} id={m.userId} name={m.name} label={m.userId === myId ? m.name + ' (вы)' : m.name} photo={m.photo} online={!!m.online || m.userId === myId}
            subtitle={m.userId === myId ? 'в сети' : lastSeenText(!!m.online, m.lastSeen)} trailing={badge(m)} onClick={() => open(m)} />
        )) : <p class="app-gm-empty">Никого не нашлось</p> : <Loading />}
      </div>
      <Modal open={!!menu} onClose={() => setMenu(null)} title={menu?.name ?? ''} size="confirm" closeButton={false}
        actions={[<button key="x" type="button" class="rl-mdl-btn" onClick={() => setMenu(null)}>Закрыть</button>]}>
        {menu ? (
          <div class="app-gm-actions">
            <button type="button" class="rl-optrow" onClick={() => { const id = menu.userId; setMenu(null); nav.close(); void openUserChat(id); }}>Написать сообщение</button>
            {canPromote ? <button type="button" class="rl-optrow" onClick={() => { const id = menu.userId; setMenu(null); nav.go('gAdminRights', { userId: id, fresh: true }); }}>Назначить администратором</button> : null}
            {canBan && !channel ? <button type="button" class="rl-optrow" onClick={() => { const id = menu.userId; setMenu(null); nav.go('gException', { userId: id }); }}>Ограничить права</button> : null}
            {canBan ? <button type="button" class="rl-optrow app-gm-danger" onClick={() => void remove(menu)}>{channel ? 'Удалить из канала' : 'Удалить из группы'}</button> : null}
          </div>
        ) : null}
      </Modal>
    </GPage>
  );
}

/** Добавить участников: контакты и собеседники, кроме тех, кто уже в группе. Кого нельзя — предложить ссылку. */
export function AddMembers({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { me: my, membersRev, kind } = useGroup(chatId);
  const me = useGlobal((s) => s.me!.userId);
  const contacts = useGlobal((s) => s.contacts);
  const chats = useGlobal((s) => s.chats);
  const all = useGroupData<{ members: GroupMember[] }>(`/groups/${chatId}/members`, membersRev);
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<number[]>([]);
  const inside = new Set((all.data?.members ?? []).map((m) => m.userId));
  const people = candidates(contacts, chats.filter((c) => !isSystemChat(c)), me).filter((p) => !inside.has(p.id));
  const nameOf = (id: number) => people.find((p) => p.id === id)?.name ?? '';
  const add = async () => {
    if (!picked.length) return;
    setBusy(true);
    const r = await act<{ added: number[]; failed: number[] }>('POST', `/groups/${chatId}/members`, { userIds: picked });
    setBusy(false);
    if (!r) return;
    if (r.added.length) showToast(r.added.length === 1 ? `${nameOf(r.added[0])} в группе` : `Добавлено: ${r.added.length}`);
    if (r.failed.length) setFailed(r.failed); else nav.back();
  };
  // как в Telegram: тем, кого нельзя добавить, — пригласительная ссылка в личные сообщения
  const sendLinks = async () => {
    const ids = failed;
    setFailed([]);
    const inv = adminCan(my, 'invite') ? await act<{ invites: GroupInvite[] }>('GET', `/groups/${chatId}/invites`) : null;
    const primary = inv?.invites.find((i) => i.primary && !i.revoked);
    if (!primary) { showToast('Нет ссылки-приглашения'); nav.back(); return; }
    for (const id of ids) {
      try { await engineSend(await createDirectChat(id), inviteUrl(primary.link)); } catch { /* без сети — сообщение в очереди */ }
    }
    showToast('Приглашения отправлены');
    nav.back();
  };
  return (
    <GPage title={kind === 'channel' ? 'Добавить подписчиков' : 'Добавить участников'} onBack={nav.back} fab={{ show: picked.length > 0, icon: 'check', label: 'Добавить', onClick: add, busy }}>
      <div class="rl-page-scroll app-newgroup">
        {all.data ? (
          <ContactPicker multi selected={picked} contacts={people.map((p) => ({ ...p, tone: peerTone(p.id), avatar: senderAvatar(p.id) }))}
            searchLabel="Поиск людей" placeholder="Кого добавить?" onChange={(ids: number[]) => setPicked(ids)}
            empty="Здесь появятся ваши контакты и собеседники, которых ещё нет в группе." />
        ) : <Loading />}
      </div>
      <Modal open={failed.length > 0} onClose={() => { setFailed([]); nav.back(); }} title="Не удалось добавить" size="confirm" closeButton={false}
        actions={[
          <button key="no" type="button" class="rl-mdl-btn" onClick={() => { setFailed([]); nav.back(); }}>Не нужно</button>,
          adminCan(my, 'invite') ? <button key="ok" type="button" class="rl-mdl-btn" onClick={() => void sendLinks()}>Отправить ссылку</button> : null,
        ]}>
        <p class="rl-mdl-text">{failed.map(nameOf).filter(Boolean).join(', ') || 'Эти люди'} — нельзя добавить в группу напрямую. {adminCan(my, 'invite') ? 'Можно отправить им пригласительную ссылку.' : ''}</p>
      </Modal>
    </GPage>
  );
}
