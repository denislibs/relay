import { Button, ConfirmDialog, Icon, InfoRow, RadioRow, Section, Switch, TextField } from '@relay/ui';
import { INVITE_USAGE_MAX, type GroupInvite, type JoinRequest } from '@relay/protocol';
import { useEffect, useState } from 'preact/hooks';
import { startDirectChat } from '../../data';
import { act, copyText, inviteUrl, plural, publicUrl, useGroup, useGroupData } from '../../groups';
import { clock, dayLabel } from '../format';
import { GPage, Loading, PersonRow } from './common';
import type { Nav } from './Manage';

const short = (url: string) => url.replace(/^https?:\/\//, '');
const expired = (i: GroupInvite) => !!i.expiresAt && Date.parse(i.expiresAt) <= Date.now();
const full = (i: GroupInvite) => i.usageLimit != null && i.usage >= i.usageLimit;

/** «осталось 3 · истекает через 2 ч · заявки: 1» — как подпись ссылки в Telegram. */
function inviteSubtitle(i: GroupInvite): string {
  const parts: string[] = [];
  if (i.usageLimit != null && !full(i)) parts.push(`можно вступить: ${i.usageLimit - i.usage}`);
  else parts.push(i.usage ? `${i.usage} ${plural(i.usage, 'вступил', 'вступили', 'вступили')}` : 'никто не вступил');
  if (i.requests) parts.push(`${i.requests} ${plural(i.requests, 'заявка', 'заявки', 'заявок')}`);
  if (i.revoked) parts.push('отозвана');
  else if (full(i)) parts.push('лимит исчерпан');
  else if (expired(i)) parts.push('истекла');
  else if (i.expiresAt) parts.push('до ' + dayLabel(i.expiresAt) + ' ' + clock(i.expiresAt));
  if (i.approval) parts.push('с одобрением');
  return parts.join(' · ');
}
const tone = (i: GroupInvite) => (i.revoked ? 'gray' : expired(i) || full(i) ? 'red' : 'blue');

/** «Пригласительные ссылки»: основная (копировать, сбросить), свои ссылки, отозванные. */
export function Invites({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { group } = useGroup(chatId);
  const inv = useGroupData<{ invites: GroupInvite[] }>(`/groups/${chatId}/invites`, group);
  const [ask, setAsk] = useState<{ kind: 'revoke' | 'delete' | 'deleteAll'; invite?: GroupInvite } | null>(null);
  const list = inv.data?.invites ?? [];
  const primary = list.find((i) => i.primary && !i.revoked);
  const extra = list.filter((i) => !i.primary && !i.revoked).sort((a, b) => b.usage - a.usage || b.id - a.id);
  const revoked = list.filter((i) => i.revoked);
  const run = async () => {
    const a = ask!; setAsk(null);
    const ok = a.kind === 'revoke' ? await act('PATCH', `/groups/${chatId}/invites/${a.invite!.id}`, { revoked: true }, 'Ссылка отозвана')
      : a.kind === 'delete' ? await act('DELETE', `/groups/${chatId}/invites/${a.invite!.id}`)
      : await act('DELETE', `/groups/${chatId}/invites`);
    if (ok) inv.reload();
  };
  return (
    <GPage title="Пригласительные ссылки" onBack={nav.back}>
      <Section footer="По ссылке в группу можно вступить, даже если вы не в контактах. Сбросьте ссылку, если она попала не туда.">
        {group?.username ? (
          <InfoRow tile="blue" icon="link" title={short(publicUrl(group.username))} subtitle="Публичная ссылка · нажмите, чтобы скопировать" onClick={() => copyText(publicUrl(group.username!))} />
        ) : primary ? (
          <>
            <InfoRow tile="blue" icon="link" title={short(inviteUrl(primary.link))} subtitle={'Основная ссылка · ' + inviteSubtitle(primary)} onClick={() => copyText(inviteUrl(primary.link))} />
            <div class="app-gm-linkbtns">
              <Button variant="primary" onClick={() => copyText(inviteUrl(primary.link))}>Скопировать</Button>
              <Button onClick={() => setAsk({ kind: 'revoke', invite: primary })}>Сбросить</Button>
            </div>
          </>
        ) : <Loading />}
      </Section>
      <Section title="Дополнительные ссылки" footer="Можно ограничить срок, число вступлений или включить одобрение заявок.">
        <InfoRow icon="plus" title="Создать ссылку" onClick={() => nav.go('gInvite')} />
        {extra.map((i) => (
          <InfoRow key={i.id} tile={tone(i)} icon="link" title={i.title || short(inviteUrl(i.link))} subtitle={inviteSubtitle(i)} onClick={() => nav.go('gInviteInfo', { inviteId: i.id })} />
        ))}
      </Section>
      {revoked.length ? (
        <Section title="Отозванные ссылки">
          <InfoRow icon="trash" danger title="Удалить все отозванные" onClick={() => setAsk({ kind: 'deleteAll' })} />
          {revoked.map((i) => (
            <InfoRow key={i.id} tile="gray" icon="link" title={i.title || short(inviteUrl(i.link))} subtitle={inviteSubtitle(i)} onClick={() => setAsk({ kind: 'delete', invite: i })} />
          ))}
        </Section>
      ) : null}
      <ConfirmDialog open={!!ask} danger
        title={ask?.kind === 'revoke' ? 'Отозвать ссылку?' : ask?.kind === 'delete' ? 'Удалить ссылку?' : 'Удалить все отозванные?'}
        text={ask?.kind === 'revoke' ? (ask.invite?.primary ? 'Старая ссылка перестанет работать, появится новая.' : 'По ссылке больше нельзя будет вступить.') : 'Ссылки исчезнут из списка насовсем.'}
        confirm={ask?.kind === 'revoke' ? 'Отозвать' : 'Удалить'} onCancel={() => setAsk(null)} onConfirm={() => void run()} />
    </GPage>
  );
}

const PERIODS: { label: string; ms: number | null }[] = [
  { label: '1 час', ms: 3600_000 }, { label: '1 день', ms: 86400_000 }, { label: '1 неделя', ms: 7 * 86400_000 }, { label: 'Без ограничения', ms: null },
];
const LIMITS: (number | null)[] = [1, 10, 100, null];
const localInput = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** Создать или изменить ссылку: одобрение, название, срок, лимит вступлений. */
export function InviteEdit({ nav }: { nav: Nav }) {
  const { chatId, params } = nav;
  const { group } = useGroup(chatId);
  const inv = useGroupData<{ invites: GroupInvite[] }>(params.inviteId ? `/groups/${chatId}/invites` : null, group);
  const editing = params.inviteId ? inv.data?.invites.find((i) => i.id === params.inviteId) ?? null : null;
  const [approval, setApproval] = useState(false);
  const [title, setTitle] = useState('');
  const [period, setPeriod] = useState<number | 'custom' | null>(null);
  const [until, setUntil] = useState(localInput(new Date(Date.now() + 3600_000).toISOString()));
  const [limit, setLimit] = useState<number | 'custom' | null>(null);
  const [custom, setCustom] = useState('10');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!editing) return;
    setApproval(editing.approval); setTitle(editing.title ?? '');
    if (editing.expiresAt) { setPeriod('custom'); setUntil(localInput(new Date(Math.max(Date.parse(editing.expiresAt), Date.now() + 3600_000)).toISOString())); }
    if (editing.usageLimit != null) { if (LIMITS.includes(editing.usageLimit)) setLimit(editing.usageLimit); else { setLimit('custom'); setCustom(String(editing.usageLimit)); } }
  }, [editing?.id]);
  if (params.inviteId && !editing) return <GPage title="Изменить ссылку" onBack={nav.back}><Loading /></GPage>;
  const usage = limit === 'custom' ? Number(custom) : limit;
  const badLimit = limit === 'custom' && !(Number.isInteger(usage) && usage! >= 1 && usage! <= INVITE_USAGE_MAX);
  const save = async () => {
    if (badLimit) return;
    const expiresAt = period === 'custom' ? new Date(until).toISOString() : period ? new Date(Date.now() + period).toISOString() : null;
    const body = { title: title.trim() || null, approval, expiresAt, usageLimit: approval ? null : usage };
    setBusy(true);
    const ok = editing ? await act('PATCH', `/groups/${chatId}/invites/${editing.id}`, body) : await act('POST', `/groups/${chatId}/invites`, body, 'Ссылка создана');
    setBusy(false);
    if (ok) nav.back();
  };
  return (
    <GPage title={editing ? 'Изменить ссылку' : 'Новая ссылка'} onBack={nav.back} fab={{ show: true, icon: 'check', label: 'Сохранить', onClick: save, busy }}>
      <Section footer={approval ? 'Вступающие по ссылке будут подавать заявку — её одобрят администраторы.' : 'Вступить по ссылке можно сразу.'}>
        <InfoRow icon="userCheck" title="Одобрять новых участников" trailing={<Switch id="inv-approval" label="Одобрять новых участников" checked={approval} onChange={() => setApproval(!approval)} />} />
      </Section>
      <Section footer="Название видно только администраторам.">
        <TextField label="Название ссылки (необязательно)" value={title} maxLength={32} onInput={(v: string) => setTitle(v)} />
      </Section>
      <Section title="Срок действия" role="radiogroup">
        {PERIODS.map((p) => <RadioRow key={p.label} checked={period === p.ms} label={p.label} onClick={() => setPeriod(p.ms)} />)}
        <RadioRow checked={period === 'custom'} label="Свой срок" onClick={() => setPeriod('custom')} />
        {period === 'custom' ? <div class="app-gm-pad"><input type="datetime-local" class="app-gm-date" value={until} min={localInput(new Date().toISOString())} onInput={(e) => setUntil((e.currentTarget as HTMLInputElement).value)} /></div> : null}
      </Section>
      {!approval ? (
        <Section title="Сколько человек может вступить" role="radiogroup">
          {LIMITS.map((l) => <RadioRow key={String(l)} checked={limit === l} label={l == null ? 'Без ограничения' : String(l)} onClick={() => setLimit(l)} />)}
          <RadioRow checked={limit === 'custom'} label="Своё число" onClick={() => setLimit('custom')} />
          {limit === 'custom' ? <TextField label="Число вступлений" value={custom} inputMode="numeric" error={badLimit ? `От 1 до ${INVITE_USAGE_MAX}` : undefined} onInput={(v: string) => setCustom(v.replace(/\D/g, ''))} /> : null}
        </Section>
      ) : null}
    </GPage>
  );
}

/** Ссылка: адрес, кто создал, кто вступил и кто ждёт одобрения. */
export function InviteInfo({ nav }: { nav: Nav }) {
  const { chatId, params } = nav;
  const { group } = useGroup(chatId);
  const inv = useGroupData<{ invites: GroupInvite[] }>(`/groups/${chatId}/invites`, group);
  const i = inv.data?.invites.find((x) => x.id === params.inviteId) ?? null;
  const joined = useGroupData<{ joined: { userId: number; name: string; photo: null; at: string }[]; requests: JoinRequest[] }>(i ? `/groups/${chatId}/invites/${i.id}/joined` : null, group);
  const [ask, setAsk] = useState(false);
  if (!i) return <GPage title="Ссылка" onBack={nav.back}><Loading /></GPage>;
  const revoke = async () => { setAsk(false); if (await act('PATCH', `/groups/${chatId}/invites/${i.id}`, { revoked: true }, 'Ссылка отозвана')) nav.back(); };
  return (
    <GPage title={i.title || 'Ссылка'} onBack={nav.back} action={!i.revoked && !i.primary ? { icon: 'pencil', label: 'Изменить', onClick: () => nav.go('gInvite', { inviteId: i.id }) } : undefined}>
      <Section footer={inviteSubtitle(i)}>
        <InfoRow tile={tone(i)} icon="link" title={short(inviteUrl(i.link))} subtitle="Нажмите, чтобы скопировать" onClick={() => copyText(inviteUrl(i.link))} />
        {!i.revoked ? <InfoRow icon="close" danger title="Отозвать ссылку" onClick={() => setAsk(true)} /> : null}
      </Section>
      <Section title="Создал(а)">
        {i.creatorId ? <PersonRow id={i.creatorId} name={i.creatorName ?? ''} subtitle={dayLabel(i.createdAt) + ' ' + clock(i.createdAt)} /> : null}
      </Section>
      <Section title={joined.data?.joined.length ? `${joined.data.joined.length} ${plural(joined.data.joined.length, 'вступил', 'вступили', 'вступили')}` : 'Вступившие'}>
        {joined.data ? joined.data.joined.length ? joined.data.joined.map((j) => (
          <PersonRow key={j.userId} id={j.userId} name={j.name} subtitle={dayLabel(j.at) + ' ' + clock(j.at)} onClick={() => { nav.close(); void startDirectChat(j.userId); }} />
        )) : <p class="app-gm-empty">{i.usageLimit != null ? `Вступить могут ещё ${i.usageLimit - i.usage}` : 'Пока никто не вступил'}</p> : <Loading />}
      </Section>
      {joined.data?.requests.length && !i.revoked ? (
        <Section title="Ждут одобрения">
          {joined.data.requests.map((r) => <RequestRow key={r.userId} chatId={chatId} r={r} onDone={joined.reload} />)}
        </Section>
      ) : null}
      <ConfirmDialog open={ask} danger title="Отозвать ссылку?" text="По ссылке больше нельзя будет вступить." confirm="Отозвать" onCancel={() => setAsk(false)} onConfirm={() => void revoke()} />
    </GPage>
  );
}

function RequestRow({ chatId, r, onDone }: { chatId: number; r: JoinRequest; onDone: () => void }) {
  const decide = async (approve: boolean) => { if (await act('POST', `/groups/${chatId}/requests/${r.userId}`, { approve }, approve ? `${r.name} в группе` : undefined)) onDone(); };
  return (
    <div class="app-gm-request">
      <PersonRow id={r.userId} name={r.name} photo={r.photo} subtitle={r.about || (dayLabel(r.at) + ' ' + clock(r.at))} />
      <div class="app-gm-request-btns">
        <Button variant="primary" onClick={() => void decide(true)}><Icon name="check" size={18} /> Принять</Button>
        <Button onClick={() => void decide(false)}>Отклонить</Button>
      </div>
    </div>
  );
}

/** «Заявки на вступление»: принять или отклонить каждого; все сразу. */
export function Requests({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { group } = useGroup(chatId);
  const reqs = useGroupData<{ requests: JoinRequest[] }>(`/groups/${chatId}/requests`, group?.requests);
  const [ask, setAsk] = useState<boolean | null>(null);
  const list = reqs.data?.requests ?? [];
  const all = async () => { const approve = ask!; setAsk(null); if (await act('POST', `/groups/${chatId}/requests`, { approve })) reqs.reload(); };
  return (
    <GPage title="Заявки на вступление" onBack={nav.back}>
      {list.length > 1 ? (
        <div class="app-gm-linkbtns">
          <Button variant="primary" onClick={() => setAsk(true)}>Принять всех</Button>
          <Button onClick={() => setAsk(false)}>Отклонить всех</Button>
        </div>
      ) : null}
      <Section footer="Заявки приходят, когда включено одобрение новых участников.">
        {reqs.data ? list.length ? list.map((r) => <RequestRow key={r.userId} chatId={chatId} r={r} onDone={reqs.reload} />)
          : <p class="app-gm-empty">Новых заявок нет</p> : <Loading />}
      </Section>
      <ConfirmDialog open={ask !== null} danger={ask === false} title={ask ? 'Принять всех?' : 'Отклонить всех?'}
        text={ask ? `В группу вступят ${list.length} ${plural(list.length, 'человек', 'человека', 'человек')}.` : 'Все заявки будут отклонены.'}
        confirm={ask ? 'Принять' : 'Отклонить'} onCancel={() => setAsk(null)} onConfirm={() => void all()} />
    </GPage>
  );
}
