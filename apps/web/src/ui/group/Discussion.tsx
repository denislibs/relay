import { ConfirmDialog, InfoRow, Section } from '@relay/ui';
import type { GroupInfo, ProfilePhoto } from '@relay/protocol';
import { useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import { act, plural, useGroup, useGroupData } from '../../groups';
import { GPage, Loading } from './common';
import type { Nav } from './Manage';

type Candidate = { id: number; title: string; photo: ProfilePhoto | null; members: number };

/**
 * «Обсуждение» канала (как Discussion в Telegram): привязанная группа — с «Отвязать»; нет — список моих групп,
 * где я админ (GET discussion-candidates). Привязка — с предупреждениями: частный канал откроет посты участникам
 * группы, частная группа — комментарии только её участникам, скрытая история группы станет видна.
 */
export function Discussion({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { group } = useGroup(chatId);
  const linked = group?.linkedChatId ?? null;
  const chats = useGlobal((s) => s.chats);
  const linkedChat = linked != null ? chats.find((c) => c.id === linked) : undefined;
  const list = useGroupData<{ groups: Candidate[] }>(linked == null ? `/groups/${chatId}/discussion-candidates` : null, group);
  const [ask, setAsk] = useState<Candidate | 'unlink' | null>(null);
  const [busy, setBusy] = useState(false);
  if (!group) return <GPage title="Обсуждение" onBack={nav.back}><Loading /></GPage>;

  const infoOf = (id: number) => (chats.find((c) => c.id === id)?.group as GroupInfo | undefined) ?? null;
  const warnings = (c: Candidate): string[] => {
    const g = infoOf(c.id), out: string[] = [];
    if (!group.username) out.push('Канал частный: все участники группы увидят его посты и вложения.');
    if (g && !g.username) out.push('Группа частная: комментировать смогут только её участники.');
    if (g?.historyHidden) out.push('История группы станет видна новым участникам.');
    return out;
  };
  const link = async (c: Candidate) => {
    setAsk(null); setBusy(true);
    const ok = await act('PUT', `/groups/${chatId}/discussion`, { groupId: c.id }, `«${c.title}» — теперь обсуждение канала`);
    setBusy(false);
    if (ok) nav.back();
  };
  const unlink = async () => {
    setAsk(null); setBusy(true);
    await act('PUT', `/groups/${chatId}/discussion`, { groupId: null }, 'Группа отвязана');
    setBusy(false);
  };
  const picked = ask && ask !== 'unlink' ? ask : null;

  return (
    <GPage title="Обсуждение" onBack={nav.back}>
      {linked != null ? (
        <>
          <Section footer="Посты канала приходят в эту группу; подписчики обсуждают их в комментариях.">
            <InfoRow tile="blue" icon="chats" title={(linkedChat?.title as string | undefined) ?? 'Группа обсуждения'} subtitle="Привязанная группа" />
          </Section>
          <Section>
            <InfoRow icon="close" danger title="Отвязать группу" onClick={() => !busy && setAsk('unlink')} />
          </Section>
        </>
      ) : (
        <Section title="Выберите группу" footer="Каждый пост канала появится в группе, а подписчики смогут оставлять к нему комментарии. Здесь — ваши группы, где вы администратор.">
          {list.data ? list.data.groups.length ? list.data.groups.map((c) => (
            <InfoRow key={c.id} tile="green" icon="community" title={c.title} subtitle={`${c.members} ${plural(c.members, 'участник', 'участника', 'участников')}`}
              onClick={() => !busy && setAsk(c)} />
          )) : <p class="app-gm-empty">Подходящих групп нет — создайте группу и станьте её администратором.</p> : <Loading />}
        </Section>
      )}
      <ConfirmDialog open={!!picked} title="Привязать группу?" confirm="Привязать"
        text={picked ? [`«${picked.title}» станет обсуждением канала «${group.title}».`, ...warnings(picked)].join(' ') : ''}
        onCancel={() => setAsk(null)} onConfirm={() => { if (picked) void link(picked); }} />
      <ConfirmDialog open={ask === 'unlink'} danger title="Отвязать группу?" confirm="Отвязать"
        text="Новые посты перестанут приходить в группу, кнопки комментариев под постами пропадут. Старые обсуждения останутся в группе."
        onCancel={() => setAsk(null)} onConfirm={() => void unlink()} />
    </GPage>
  );
}
