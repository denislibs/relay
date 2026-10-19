import { CheckRow, ConfirmDialog, InfoRow, Modal, Section, TextField } from '@relay/ui';
import { ADMIN_RIGHTS, RANK_MAX, allAdminRights, noAdminRights, type AdminRights, type GroupMember } from '@relay/protocol';
import { useState } from 'preact/hooks';
import { proofOf } from '../../authSettings';
import { useGlobal } from '../../global';
import { ADMIN_RIGHT_TEXT, act, adminCan, errorText, sameAdmin, useGroup, useGroupData } from '../../groups';
import { showToast } from '../../settingsData';
import { lastSeenText } from '../format';
import { GPage, Loading, PersonRow } from './common';
import type { Nav } from './Manage';

/** «Администраторы»: владелец первым, у остальных — кто назначил; «+» — назначить. */
export function Admins({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { me, membersRev } = useGroup(chatId);
  const all = useGroupData<{ members: GroupMember[] }>(`/groups/${chatId}/members`, membersRev);
  const names = new Map((all.data?.members ?? []).map((m) => [m.userId, m.name]));
  const admins = (all.data?.members ?? []).filter((m) => m.role !== 'member');
  return (
    <GPage title="Администраторы" onBack={nav.back} fab={adminCan(me, 'addAdmins') ? { show: true, icon: 'userPlus', label: 'Назначить администратора', onClick: () => nav.go('gAdminPick') } : undefined}>
      <Section footer="Администраторы помогают управлять группой. Права каждого настраиваются отдельно.">
        {all.data ? admins.map((m) => (
          <PersonRow key={m.userId} id={m.userId} name={m.name} photo={m.photo} trailing={m.rank ?? undefined}
            subtitle={m.role === 'owner' ? 'Владелец' : m.promotedBy && names.has(m.promotedBy) ? `Назначил(а) ${names.get(m.promotedBy)}` : 'Администратор'}
            onClick={() => nav.go('gAdminRights', { userId: m.userId })} />
        )) : <Loading />}
      </Section>
    </GPage>
  );
}

/** Права администратора: чекбоксы (только те, что есть у меня), звание, снять с должности, передать права на группу. */
export function AdminRightsPage({ nav }: { nav: Nav }) {
  const { chatId, params } = nav;
  const { me, membersRev, group } = useGroup(chatId);
  const myId = useGlobal((s) => s.me!.userId);
  const all = useGroupData<{ members: GroupMember[] }>(`/groups/${chatId}/members`, membersRev);
  const target = all.data?.members.find((m) => m.userId === params.userId) ?? null;
  const [draft, setDraft] = useState<AdminRights | null>(null);
  const [rank, setRank] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<'dismiss' | 'transfer' | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | undefined>();
  if (!target || !me || !group) return <GPage title="Права администратора" onBack={nav.back}><Loading /></GPage>;

  const isOwner = target.role === 'owner';
  const self = target.userId === myId;
  const fresh = !!params.fresh && target.role === 'member';
  // владелец правит всех; админ с правом назначать — новых и назначенных им; своё звание — всегда сам
  const editable = !isOwner && (me.role === 'owner' || (adminCan(me, 'addAdmins') && (fresh || target.promotedBy === myId)));
  const rankEditable = editable || self;
  const mine = me.admin ?? noAdminRights();
  const start = isOwner ? allAdminRights() : target.admin ?? (fresh ? { ...mine, addAdmins: false } : noAdminRights());
  const rights = draft ?? start;
  const r0 = target.rank ?? '';
  const r1 = rank ?? r0;
  const dirty = fresh || (editable && !sameAdmin(rights, start)) || r1.trim() !== r0;

  const save = async () => {
    setBusy(true);
    const ok = editable
      ? await act('PUT', `/groups/${chatId}/admins/${target.userId}`, { rights, rank: r1.trim() || null })
      : await act('PUT', `/groups/${chatId}/members/${target.userId}/rank`, { rank: r1.trim() || null });
    setBusy(false);
    if (ok) nav.back();
  };
  const dismiss = async () => { setAsk(null); if (await act('PUT', `/groups/${chatId}/admins/${target.userId}`, { rights: null }, `${target.name} больше не администратор`)) nav.back(); };
  const transfer = async () => {
    if (!password) return;
    setBusy(true);
    const p = await proofOf(password);
    const r = p.ok ? await act('POST', `/groups/${chatId}/owner`, { userId: target.userId, proof: p.data }) : null;
    setBusy(false);
    if (!p.ok) { setPwErr(errorText(p.code)); return; }
    if (r) { setPassword(null); showToast(`${target.name} теперь владелец группы`); nav.back(); }
  };

  return (
    <GPage title={fresh ? 'Новый администратор' : 'Права администратора'} onBack={nav.back}
      fab={rankEditable ? { show: dirty, icon: 'check', label: 'Сохранить', onClick: save, busy } : undefined}>
      <Section>
        <PersonRow id={target.userId} name={target.name} photo={target.photo} online={!!target.online} subtitle={self ? 'это вы' : lastSeenText(!!target.online, target.lastSeen)} />
      </Section>
      <Section title="Что может этот администратор" footer={!editable && !isOwner ? 'Менять права может владелец или тот, кто назначил этого администратора.' : isOwner ? 'У владельца все права.' : undefined}>
        {ADMIN_RIGHTS.map((k) => (
          <CheckRow key={k} label={ADMIN_RIGHT_TEXT[k]} checked={rights[k]} disabled={!editable || !mine[k]}
            onChange={(on: boolean) => setDraft({ ...rights, [k]: on })} />
        ))}
      </Section>
      <Section title="Звание" footer="Звание видно в списке участников и рядом с именем в сообщениях.">
        <TextField label={isOwner ? 'Владелец' : 'Администратор'} value={r1} disabled={!rankEditable} maxLength={RANK_MAX} onInput={(v: string) => setRank(v)} />
      </Section>
      {!fresh && !isOwner && editable && !self ? (
        <Section>
          <InfoRow icon="userMinus" danger title="Снять с должности" onClick={() => setAsk('dismiss')} />
        </Section>
      ) : null}
      {me.role === 'owner' && !self && !isOwner ? (
        <Section footer="Новый владелец получит все права, а вы останетесь администратором.">
          <InfoRow icon="crown" title="Передать права на группу" onClick={() => setAsk('transfer')} />
        </Section>
      ) : null}
      <ConfirmDialog open={ask === 'dismiss'} danger title="Снять с должности?" text={`${target.name} станет обычным участником.`} confirm="Снять" onCancel={() => setAsk(null)} onConfirm={() => void dismiss()} />
      <ConfirmDialog open={ask === 'transfer'} danger title="Передать права на группу?" text={`${target.name} станет владельцем «${group.title}». Отменить это может только новый владелец.`}
        confirm="Продолжить" onCancel={() => setAsk(null)} onConfirm={() => { setAsk(null); setPwErr(undefined); setPassword(''); }} />
      <Modal open={password !== null} onClose={() => setPassword(null)} title="Облачный пароль" size="confirm"
        actions={[
          <button key="no" type="button" class="rl-mdl-btn" onClick={() => setPassword(null)}>Отмена</button>,
          <button key="ok" type="button" class="rl-mdl-btn rl-mdl-btn-danger" disabled={busy || !password} onClick={() => void transfer()}>Передать</button>,
        ]}>
        <p class="rl-mdl-text">Чтобы передать права на группу, введите облачный пароль.</p>
        <TextField label="Пароль" type="password" value={password ?? ''} error={pwErr} autoFocus onInput={(v: string) => { setPassword(v); setPwErr(undefined); }}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') void transfer(); }} />
      </Modal>
    </GPage>
  );
}
