import { ConfirmDialog, InfoRow, ProfileHeader, RadioRow, Section, Switch, TextField, peerTone } from '@relay/ui';
import { GROUP_ABOUT_MAX, MEMBER_RIGHTS, rightsCount, type GroupInvite } from '@relay/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { groupCall } from '../../data';
import { useGlobal } from '../../global';
import { act, adminCan, canChangeInfo, copyText, inviteUrl, plural, publicUrl, useGroup, useGroupData } from '../../groups';
import { useMembers } from '../../members';
import { upload } from '../../profilePhoto';
import { usePhotoPicker } from '../settings/usePhotoPicker';
import { GPage } from './common';
import type { Nav } from './Manage';

const TITLE_MAX = 128;
const cpLen = (s: string) => [...s].length;
const clip = (s: string, max: number) => [...s].slice(0, max).join('');

/** «Изменить группу» — фото, название, описание и разделы управления (что видно — зависит от прав). */
export function EditGroup({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { group, me, membersRev, title: chatTitle } = useGroup(chatId);
  const members = useMembers(chatId, true, membersRev);
  const myUserId = useGlobal((s) => s.me!.userId);
  const [title, setTitle] = useState(group?.title ?? chatTitle);
  const [about, setAbout] = useState(group?.about ?? '');
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<'leave' | 'delete' | null>(null);
  // сервер прислал новое (другой админ поменял) — поля следуют, если их не трогали
  const base = useRef({ title: group?.title ?? chatTitle, about: group?.about ?? '' });
  useEffect(() => {
    if (!group) return;
    if (title === base.current.title) setTitle(group.title);
    if (about === base.current.about) setAbout(group.about);
    base.current = { title: group.title, about: group.about };
  }, [group?.title, group?.about]);

  const owner = me?.role === 'owner';
  const info = canChangeInfo(me);
  const photo = usePhotoPicker(group?.photo, {
    set: async (c) => {
      const [id, small] = await Promise.all([upload(c.big, 640), upload(c.small, 160)]);
      const r = await groupCall('PUT', `/groups/${chatId}/photo`, { id, small, thumb: c.thumb });
      if (!r.ok) throw new Error(r.code);
    },
    remove: async () => { const r = await groupCall('DELETE', `/groups/${chatId}/photo`); if (!r.ok) throw new Error(r.code); },
  });
  const invites = useGroupData<{ invites: GroupInvite[] }>(adminCan(me, 'invite') ? `/groups/${chatId}/invites` : null, group);
  if (!group || !me) return <GPage title="Изменить" onBack={nav.back}><div /></GPage>;

  const dirty = title.trim() !== group.title || about.trim() !== group.about;
  const titleErr = !title.trim() ? 'Укажите название группы' : undefined;
  const save = async () => {
    if (!dirty || titleErr) return;
    setBusy(true);
    const ok = await act('PATCH', `/groups/${chatId}`, { title: title.trim(), about: about.trim() });
    setBusy(false);
    if (ok) nav.back();
  };
  const admins = members?.members.filter((m) => m.role === 'owner' || m.role === 'admin').length;
  const live = invites.data?.invites.filter((i) => !i.revoked).length;
  const total = MEMBER_RIGHTS.length;
  const leave = async () => {
    setAsk(null);
    const ok = await act('DELETE', ask === 'delete' ? `/groups/${chatId}` : `/groups/${chatId}/members/${myUserId}`);
    if (ok) nav.close();   // чат закроется сам, когда исчезнет из списка
  };

  return (
    <GPage title="Изменить" onBack={nav.back} fab={{ show: dirty && !titleErr, icon: 'check', label: 'Сохранить', onClick: save, busy }}>
      <ProfileHeader name={title || group.title} tone={peerTone(chatId)} size={96} {...(info ? photo.avatar : {})} />
      {info ? photo.ui : null}
      <Section>
        <TextField label="Название группы" value={title} disabled={!info} maxLength={TITLE_MAX} measure={cpLen} error={titleErr}
          onInput={(v: string, e: Event) => { const c = clip(v, TITLE_MAX); if (c !== v) (e.currentTarget as HTMLInputElement).value = c; setTitle(c); }} />
        <TextField label="Описание" multiline rows={3} counter value={about} disabled={!info} maxLength={GROUP_ABOUT_MAX} measure={cpLen}
          hint="Расскажите, о чём эта группа" onInput={(v: string, e: Event) => { const c = clip(v, GROUP_ABOUT_MAX); if (c !== v) (e.currentTarget as HTMLTextAreaElement).value = c; setAbout(c); }} />
      </Section>
      <Section>
        {owner ? <InfoRow tile="blue" icon="lock" title="Тип группы" subtitle={group.username ? 'Публичная' : 'Частная'} onClick={() => nav.go('gType')} /> : null}
        {adminCan(me, 'ban') ? <InfoRow tile="green" icon="key" title="Разрешения" subtitle={`${rightsCount(group.rights)}/${total}`} onClick={() => nav.go('gPerms')} /> : null}
        {adminCan(me, 'info') ? <InfoRow tile="orange" icon="smile" title="Реакции" subtitle={group.reactions.mode === 'all' ? 'Все' : group.reactions.mode === 'none' ? 'Выкл.' : String(group.reactions.allowed.length)} onClick={() => nav.go('gReactions')} /> : null}
        <InfoRow tile="purple" icon="shield" title="Администраторы" subtitle={admins != null ? String(admins) : '…'} onClick={() => nav.go('gAdmins')} />
        {adminCan(me, 'invite') ? <InfoRow tile="green" icon="link" title="Пригласительные ссылки" subtitle={live != null ? String(live) : '…'} onClick={() => nav.go('gInvites')} /> : null}
        {group.requests > 0 ? <InfoRow tile="red" icon="userPlus" title="Заявки на вступление" subtitle={String(group.requests)} onClick={() => nav.go('gRequests')} /> : null}
      </Section>
      <Section>
        <InfoRow tile="blue" icon="users" title="Участники" subtitle={`${group.members} ${plural(group.members, 'участник', 'участника', 'участников')}`} onClick={() => nav.go('gMembers')} />
      </Section>
      {!group.username && adminCan(me, 'ban') ? (
        <Section footer={group.historyHidden ? 'Новые участники не увидят сообщения, отправленные до их вступления.' : 'Новые участники увидят все сообщения группы.'}>
          <InfoRow icon="history" title="История чата для новых участников" subtitle={group.historyHidden ? 'Скрыта' : 'Видна'}
            trailing={<Switch id="g-history" label="История для новых участников" checked={!group.historyHidden}
              onChange={() => void act('PUT', `/groups/${chatId}/settings`, { historyHidden: !group.historyHidden })} />} />
        </Section>
      ) : null}
      <Section>
        <InfoRow icon="logout" danger title={owner ? 'Удалить и покинуть группу' : 'Покинуть группу'} onClick={() => setAsk(owner ? 'delete' : 'leave')} />
      </Section>
      <ConfirmDialog open={!!ask} danger title={ask === 'delete' ? 'Удалить группу?' : 'Покинуть группу?'}
        text={ask === 'delete' ? `Группа «${group.title}» будет удалена у всех участников вместе с историей.` : `Вы покинете «${group.title}». Вернуться можно будет только по приглашению.`}
        confirm={ask === 'delete' ? 'Удалить у всех' : 'Покинуть'} onCancel={() => setAsk(null)} onConfirm={() => void leave()} />
    </GPage>
  );
}

/** «Тип группы» (владелец): частная по ссылке или публичная по @имени; одобрение вступающих; запрет копирования. */
export function GroupType({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { group, me } = useGroup(chatId);
  const [pub, setPub] = useState(!!group?.username);
  const [name, setName] = useState(group?.username ?? '');
  const [status, setStatus] = useState<'checking' | 'free' | 'taken' | 'invalid' | null>(null);
  const [busy, setBusy] = useState(false);
  const [askPrivate, setAskPrivate] = useState(false);
  const [askRevoke, setAskRevoke] = useState(false);
  const invites = useGroupData<{ invites: GroupInvite[] }>(`/groups/${chatId}/invites`, group);
  const primary = invites.data?.invites.find((i) => i.primary && !i.revoked) ?? null;
  // проверка имени — с задержкой, пока печатают
  useEffect(() => {
    if (!pub) { setStatus(null); return; }
    const n = name.trim().replace(/^@/, '');
    if (n && n.toLowerCase() === group?.username) { setStatus(null); return; }
    if (!/^[a-z][a-z0-9_]{4,31}$/i.test(n)) { setStatus(n ? 'invalid' : null); return; }
    setStatus('checking');
    const t = setTimeout(() => {
      void groupCall<{ ok: boolean; reason?: string }>('GET', `/groups/username/check?username=${encodeURIComponent(n)}&chatId=${chatId}`).then((r) => {
        if (r.ok) setStatus(r.data.ok ? 'free' : r.data.reason === 'taken' ? 'taken' : 'invalid');
      });
    }, 400);
    return () => clearTimeout(t);
  }, [name, pub]);
  if (!group || !me) return <GPage title="Тип группы" onBack={nav.back}><div /></GPage>;

  const was = group.username;
  const n = name.trim().replace(/^@/, '').toLowerCase();
  const dirty = pub ? n !== (was ?? '') : !!was;
  const valid = !pub || (status === 'free' || n === was);
  const save = async () => {
    if (!dirty || !valid) return;
    if (!pub && was && !askPrivate) { setAskPrivate(true); return; }
    setAskPrivate(false);
    setBusy(true);
    const ok = await act('PUT', `/groups/${chatId}/username`, { username: pub ? n : null });
    setBusy(false);
    if (ok) nav.back();
  };
  const revoke = async () => {
    setAskRevoke(false);
    if (primary && await act('PATCH', `/groups/${chatId}/invites/${primary.id}`, { revoked: true }, 'Ссылка сброшена')) invites.reload();
  };
  const hint = status === 'checking' ? 'Проверяем…' : status === 'free' ? `${n} — свободно` : undefined;
  const err = status === 'taken' ? 'Это имя уже занято' : status === 'invalid' ? 'Имя: 5–32 символа, латиница, цифры и _' : undefined;

  return (
    <GPage title="Тип группы" onBack={nav.back} fab={{ show: dirty && valid, icon: 'check', label: 'Сохранить', onClick: save, busy }}>
      <Section title="Тип группы" role="radiogroup">
        <RadioRow checked={!pub} label="Частная" subtitle="Вступить можно только по пригласительной ссылке." onClick={() => setPub(false)} />
        <RadioRow checked={pub} label="Публичная" subtitle="Группу можно найти по имени, вступить может любой." onClick={() => setPub(true)} />
      </Section>
      {pub ? (
        <Section title="Публичная ссылка" footer="По этой ссылке группу найдут и смогут вступить. Имя — латиница, цифры и _, от 5 символов.">
          <TextField label="Имя группы" value={name} error={err} hint={hint} class={status === 'free' ? 'app-tf-ok' : undefined} onInput={(v: string) => setName(v)} />
          {n && !err ? <button type="button" class="app-uname-link" onClick={() => copyText(publicUrl(n))}><span>Ссылка:</span> <b>{publicUrl(n).replace(/^https?:\/\//, '')}</b></button> : null}
        </Section>
      ) : (
        <Section title="Пригласительная ссылка" footer="Любой, у кого есть ссылка, сможет вступить. Сбросьте её, если она попала не туда.">
          {primary ? (
            <>
              <InfoRow icon="link" title={inviteUrl(primary.link).replace(/^https?:\/\//, '')} subtitle="Нажмите, чтобы скопировать" onClick={() => copyText(inviteUrl(primary.link))} />
              <InfoRow icon="refresh" danger title="Сбросить ссылку" onClick={() => setAskRevoke(true)} />
            </>
          ) : <div class="app-sm-loading" aria-busy="true" />}
        </Section>
      )}
      <Section title="Новые участники" footer={group.joinApproval ? 'Вступающие по ссылке или имени сначала подают заявку — её одобряют администраторы.' : 'Вступающие по ссылке попадают в группу сразу.'}>
        <InfoRow icon="userCheck" title="Одобрять новых участников"
          trailing={<Switch id="g-approval" label="Одобрять новых участников" checked={group.joinApproval}
            onChange={() => void act('PUT', `/groups/${chatId}/settings`, { joinApproval: !group.joinApproval })} />} />
      </Section>
      <Section title="Копирование" role="radiogroup" footer={group.protected ? 'Участники не смогут пересылать сообщения из группы и сохранять медиа.' : 'Участники могут пересылать сообщения из группы.'}>
        <RadioRow checked={!group.protected} label="Разрешить копирование" onClick={() => group.protected && void act('PUT', `/groups/${chatId}/settings`, { protected: false })} />
        <RadioRow checked={group.protected} label="Запретить копирование" onClick={() => !group.protected && void act('PUT', `/groups/${chatId}/settings`, { protected: true })} />
      </Section>
      <ConfirmDialog open={askPrivate} danger title="Сделать группу частной?" text={`Имя @${was} освободится — его сможет занять кто угодно.`} confirm="Сделать частной" onCancel={() => setAskPrivate(false)} onConfirm={() => void save()} />
      <ConfirmDialog open={askRevoke} danger title="Сбросить ссылку?" text="Старая ссылка перестанет работать, появится новая." confirm="Сбросить" onCancel={() => setAskRevoke(false)} onConfirm={() => void revoke()} />
    </GPage>
  );
}

