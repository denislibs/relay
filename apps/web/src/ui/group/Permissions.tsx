import { CheckRow, ConfirmDialog, Icon, InfoRow, RangeRow, SearchInput, Section } from '@relay/ui';
import { MEDIA_RIGHTS, SLOW_MODES, type BannedMember, type GroupMember, type MemberRight, type MemberRights } from '@relay/protocol';
import { useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import {
  MEMBER_RIGHT_TEXT, PLAIN_RIGHTS, SLOW_TEXT, act, mediaCount, plural, sameRights, toggleRight, useGroup, useGroupData,
} from '../../groups';
import { lastSeenText } from '../format';
import { GPage, Loading, PersonRow } from './common';
import type { Nav } from './Manage';

/** Чекбоксы прав: текст, «Медиа» с раскрытием (x/7), остальное. locked — запрещено умолчаниями (не включить). */
export function RightsList({ value, onChange, locked, disabled }: { value: MemberRights; onChange: (r: MemberRights) => void; locked?: MemberRights | null; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const off = (k: MemberRight) => disabled || (locked ? !locked[k] : false);
  const n = mediaCount(value);
  const row = (k: MemberRight) => (
    <CheckRow key={k} label={MEMBER_RIGHT_TEXT[k]} checked={value[k]} disabled={off(k)} onChange={(on: boolean) => onChange(toggleRight(value, k, on))} />
  );
  return (
    <>
      {row('text')}
      <div class="app-gm-media">
        <CheckRow label={<>Медиа <span class="app-gm-count">{n}/{MEDIA_RIGHTS.length}</span></>} checked={n > 0}
          disabled={disabled || (locked ? MEDIA_RIGHTS.every((k) => !locked[k]) : false)} onChange={(on: boolean) => onChange(toggleRight(value, 'media', on))} />
        <button type="button" class={'app-gm-expand' + (open ? ' is-open' : '')} aria-expanded={open} aria-label="Показать виды медиа" onClick={() => setOpen(!open)}>
          <Icon name="chevronDown" size={20} />
        </button>
      </div>
      <div class={'app-gm-sub' + (open ? ' is-open' : '')} inert={!open || undefined}>
        <div>{MEDIA_RIGHTS.map(row)}</div>
      </div>
      {PLAIN_RIGHTS.map(row)}
    </>
  );
}

/** Что у участника запрещено сверх умолчаний — подпись в «Исключениях». */
function extraBans(r: MemberRights, defaults: MemberRights): string {
  const list = (Object.keys(r) as MemberRight[]).filter((k) => !r[k] && defaults[k]).map((k) => MEMBER_RIGHT_TEXT[k].toLowerCase());
  return list.length ? 'Нельзя: ' + list.join(', ') : 'Без ограничений';
}

export function Permissions({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { group, membersRev } = useGroup(chatId);
  const [draft, setDraft] = useState<MemberRights | null>(null);
  const [slow, setSlow] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const restricted = useGroupData<{ members: GroupMember[] }>(`/groups/${chatId}/members?filter=restricted`, membersRev);
  const bans = useGroupData<{ banned: BannedMember[] }>(`/groups/${chatId}/bans`, membersRev);
  if (!group) return <GPage title="Разрешения" onBack={nav.back}><Loading /></GPage>;
  const rights = draft ?? group.rights;
  const slowMode = slow ?? group.slowMode;
  const dirty = !sameRights(rights, group.rights) || slowMode !== group.slowMode;
  const save = async () => {
    setBusy(true);
    const ok = await act('PUT', `/groups/${chatId}/rights`, { rights, slowMode });
    setBusy(false);
    if (ok) nav.back();
  };
  const idx = Math.max(0, SLOW_MODES.indexOf(slowMode));
  return (
    <GPage title="Разрешения" onBack={nav.back} fab={{ show: dirty, icon: 'check', label: 'Сохранить', onClick: save, busy }}>
      <Section title="Что могут участники">
        <RightsList value={rights} onChange={setDraft} />
      </Section>
      <Section title="Медленный режим" footer={slowMode ? `Участники смогут отправлять одно сообщение раз в ${SLOW_TEXT[slowMode]}.` : 'Участники пишут без ограничений по частоте.'}>
        <RangeRow label="Задержка" min={0} max={SLOW_MODES.length - 1} step={1} value={idx} format={(i: number) => SLOW_TEXT[SLOW_MODES[i]]}
          marks={SLOW_MODES.map((s, i) => ({ value: i, label: SLOW_TEXT[s] }))} onChange={(i: number) => setSlow(SLOW_MODES[i])} />
      </Section>
      <Section>
        <InfoRow tile="red" icon="userX" title="Удалённые пользователи" subtitle={bans.data ? String(bans.data.banned.length) : '…'} onClick={() => nav.go('gBanned')} />
      </Section>
      <Section title="Исключения">
        <InfoRow icon="userPlus" title="Добавить исключение" onClick={() => nav.go('gExceptionPick')} />
        {restricted.data ? restricted.data.members.map((m) => (
          <PersonRow key={m.userId} id={m.userId} name={m.name} photo={m.photo} subtitle={extraBans(m.restricted ?? group.rights, group.rights)}
            onClick={() => nav.go('gException', { userId: m.userId })} />
        )) : <Loading />}
      </Section>
    </GPage>
  );
}

/** Исключение для одного участника: те же права, но не шире умолчаний; «Удалить из группы». */
export function Exception({ nav }: { nav: Nav }) {
  const { chatId, params } = nav;
  const { group, membersRev } = useGroup(chatId);
  const all = useGroupData<{ members: GroupMember[] }>(`/groups/${chatId}/members`, membersRev);
  const member = all.data?.members.find((m) => m.userId === params.userId) ?? null;
  const [draft, setDraft] = useState<MemberRights | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false);
  if (!group || !member) return <GPage title="Исключение" onBack={nav.back}><Loading /></GPage>;
  const start = member.restricted ?? group.rights;
  const rights = draft ?? start;
  const dirty = !sameRights(rights, start);
  const save = async () => {
    setBusy(true);
    const ok = await act('PUT', `/groups/${chatId}/members/${member.userId}/restrict`, { rights });
    setBusy(false);
    if (ok) nav.back();
  };
  const remove = async () => { setAsk(false); if (await act('DELETE', `/groups/${chatId}/members/${member.userId}`)) nav.back(); };
  return (
    <GPage title="Исключение" onBack={nav.back} fab={{ show: dirty, icon: 'check', label: 'Сохранить', onClick: save, busy }}>
      <Section>
        <PersonRow id={member.userId} name={member.name} photo={member.photo} subtitle={lastSeenText(!!member.online, member.lastSeen)} online={!!member.online} />
      </Section>
      <Section title="Что может этот участник" footer="Права, выключенные для всех участников, здесь не включить.">
        <RightsList value={rights} onChange={setDraft} locked={group.rights} />
      </Section>
      <Section>
        {member.restricted ? <InfoRow icon="refresh" title="Снять исключение" onClick={() => void act('PUT', `/groups/${chatId}/members/${member.userId}/restrict`, { rights: null }).then((ok) => ok && nav.back())} /> : null}
        <InfoRow icon="userX" danger title="Удалить из группы" onClick={() => setAsk(true)} />
      </Section>
      <ConfirmDialog open={ask} danger title="Удалить из группы?" text={`${member.name} попадёт в «Удалённые» и не сможет вернуться по ссылке.`} confirm="Удалить" onCancel={() => setAsk(false)} onConfirm={() => void remove()} />
    </GPage>
  );
}

/** Выбор участника: для исключения, удаления (бана) или назначения админом. */
export function MemberPick({ nav, mode }: { nav: Nav; mode: 'exception' | 'ban' | 'admin' }) {
  const { chatId } = nav;
  const { membersRev } = useGroup(chatId);
  const me = useGlobal((s) => s.me!.userId);
  const [q, setQ] = useState('');
  const [ask, setAsk] = useState<GroupMember | null>(null);
  const all = useGroupData<{ members: GroupMember[] }>(`/groups/${chatId}/members`, membersRev);
  const title = mode === 'admin' ? 'Новый администратор' : mode === 'ban' ? 'Удалить участника' : 'Добавить исключение';
  const needle = q.trim().toLowerCase();
  const list = (all.data?.members ?? []).filter((m) => m.userId !== me && m.role === 'member'
    && (!needle || m.name.toLowerCase().includes(needle) || (m.username ?? '').toLowerCase().includes(needle)));
  const pick = (m: GroupMember) => {
    if (mode === 'ban') setAsk(m);
    else if (mode === 'admin') nav.go('gAdminRights', { userId: m.userId, fresh: true });
    else nav.go('gException', { userId: m.userId });
  };
  const ban = async () => { const m = ask!; setAsk(null); if (await act('DELETE', `/groups/${chatId}/members/${m.userId}`, undefined, `${m.name} удалён(а) из группы`)) nav.back(); };
  return (
    <GPage title={title} onBack={nav.back}>
      <div class="app-gm-search"><SearchInput id="gm-perm-search" label="Поиск участников" value={q} placeholder="Поиск участников" onInput={(e: Event) => setQ((e.currentTarget as HTMLInputElement).value)} /></div>
      <div class="app-members" role="list">
        {all.data ? list.length ? list.map((m) => (
          <PersonRow key={m.userId} id={m.userId} name={m.name} photo={m.photo} online={!!m.online} subtitle={lastSeenText(!!m.online, m.lastSeen)} onClick={() => pick(m)} />
        )) : <p class="app-gm-empty">{needle ? 'Никого не нашлось' : 'Здесь появятся участники группы'}</p> : <Loading />}
      </div>
      <ConfirmDialog open={!!ask} danger title="Удалить из группы?" text={ask ? `${ask.name} попадёт в «Удалённые» и не сможет вернуться по ссылке.` : ''} confirm="Удалить" onCancel={() => setAsk(null)} onConfirm={() => void ban()} />
    </GPage>
  );
}

/** «Удалённые пользователи»: кто и кем удалён; нажатие — вернуть возможность вступить; «+» — удалить ещё. */
export function Banned({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { membersRev } = useGroup(chatId);
  const bans = useGroupData<{ banned: BannedMember[] }>(`/groups/${chatId}/bans`, membersRev);
  const [ask, setAsk] = useState<BannedMember | null>(null);
  const unban = async () => { const b = ask!; setAsk(null); if (await act('DELETE', `/groups/${chatId}/bans/${b.userId}`, undefined, `${b.name} снова может вступить`)) bans.reload(); };
  const n = bans.data?.banned.length ?? 0;
  return (
    <GPage title="Удалённые пользователи" onBack={nav.back} fab={{ show: true, icon: 'userPlus', label: 'Удалить участника', onClick: () => nav.go('gBanPick') }}>
      <Section footer="Удалённые не могут вернуться в группу по ссылке или имени. Добавить их снова может администратор с правом блокировки.">
        {bans.data ? n ? bans.data.banned.map((b) => (
          <PersonRow key={b.userId} id={b.userId} name={b.name} photo={b.photo} subtitle={b.bannedByName ? `Удалил(а) ${b.bannedByName}` : 'Удалён(а)'} onClick={() => setAsk(b)} />
        )) : <p class="app-gm-empty">Никто не удалён</p> : <Loading />}
      </Section>
      <p class="app-gm-note">{n ? `${n} ${plural(n, 'пользователь', 'пользователя', 'пользователей')}` : ''}</p>
      <ConfirmDialog open={!!ask} title="Разблокировать?" text={ask ? `${ask.name} сможет снова вступить в группу по ссылке.` : ''} confirm="Разблокировать" onCancel={() => setAsk(null)} onConfirm={() => void unban()} />
    </GPage>
  );
}
