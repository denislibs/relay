import { RadioRow, Section } from '@relay/ui';
import type { ReactionsMode } from '@relay/protocol';
import { useState } from 'preact/hooks';
import { act, useGroup } from '../../groups';
import { GPage, Loading } from './common';
import type { Nav } from './Manage';

/** Набор, из которого выбирают «некоторые» реакции (первые шесть — быстрые реакции из меню сообщения). */
export const REACTION_SET = [
  '👍', '❤️', '😂', '😮', '😢', '🙏', '👎', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🎉', '🤩', '💯', '🤣', '⚡', '🏆',
  '💔', '🤨', '😐', '🍓', '🍾', '😈', '😴', '😭', '🤓', '👻', '👀', '🙈', '😇', '🤝', '✍️', '🤗', '🫡', '💅', '🤪', '🗿', '😎', '👌',
];

/** «Реакции»: все, некоторые (выбор эмодзи) или никаких. */
export function Reactions({ nav }: { nav: Nav }) {
  const { chatId } = nav;
  const { group } = useGroup(chatId);
  const [mode, setMode] = useState<ReactionsMode | null>(null);
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (!group) return <GPage title="Реакции" onBack={nav.back}><Loading /></GPage>;
  const m = mode ?? group.reactions.mode;
  const a = allowed ?? (group.reactions.mode === 'some' ? group.reactions.allowed : REACTION_SET.slice(0, 6));
  const dirty = m !== group.reactions.mode || (m === 'some' && (a.length !== group.reactions.allowed.length || a.some((e) => !group.reactions.allowed.includes(e))));
  const toggle = (e: string) => setAllowed(a.includes(e) ? a.filter((x) => x !== e) : [...a, e]);
  const save = async () => {
    setBusy(true);
    const ok = await act('PUT', `/groups/${chatId}/settings`, { reactions: { mode: m, allowed: m === 'some' ? a : [] } });
    setBusy(false);
    if (ok) nav.back();
  };
  return (
    <GPage title="Реакции" onBack={nav.back} fab={{ show: dirty && !(m === 'some' && !a.length), icon: 'check', label: 'Сохранить', onClick: save, busy }}>
      <Section title="Реакции в группе" role="radiogroup">
        <RadioRow checked={m === 'all'} label="Все реакции" subtitle="Участники могут ставить любые реакции." onClick={() => setMode('all')} />
        <RadioRow checked={m === 'some'} label="Некоторые" subtitle="Только реакции, выбранные ниже." onClick={() => setMode('some')} />
        <RadioRow checked={m === 'none'} label="Без реакций" subtitle="Реакции в группе выключены." onClick={() => setMode('none')} />
      </Section>
      {m === 'some' ? (
        <Section title={`Доступные реакции · ${a.length}`} footer="Нажмите на эмодзи, чтобы включить или выключить его.">
          <div class="app-gm-emoji" role="group" aria-label="Доступные реакции">
            {REACTION_SET.map((e) => (
              <button key={e} type="button" class={'app-gm-emoji-btn' + (a.includes(e) ? ' is-on' : '')} aria-pressed={a.includes(e)} aria-label={'Реакция ' + e} onClick={() => toggle(e)}>{e}</button>
            ))}
          </div>
        </Section>
      ) : null}
    </GPage>
  );
}
