import { RadioRow, Section } from '@relay/ui';
import { emojiKey, type ReactionsMode } from '@relay/protocol';
import { reactionCatalog, useReactionCatalog } from '../../reactions';
import { useState } from 'preact/hooks';
import { act, useGroup } from '../../groups';
import { GPage, Loading } from './common';
import type { Nav } from './Manage';

/** Набор на случай, когда каталога реакций с сервера нет (первые семь — быстрые реакции из меню сообщения). */
const REACTION_SET = [
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
  useReactionCatalog();
  if (!group) return <GPage title="Реакции" onBack={nav.back}><Loading /></GPage>;
  // каталог с сервера (порядок Telegram) — картинками; без него — глифы из REACTION_SET; в настройках храним ключи без FE0F
  const cat = reactionCatalog();
  const set = cat.length ? cat.map((r) => ({ key: r.key, icon: r.static })) : REACTION_SET.map((e) => ({ key: emojiKey(e), icon: undefined }));
  const m = mode ?? group.reactions.mode;
  const a = (allowed ?? (group.reactions.mode === 'some' ? group.reactions.allowed : set.slice(0, 7).map((x) => x.key))).map(emojiKey);
  const saved = group.reactions.allowed.map(emojiKey);
  const dirty = m !== group.reactions.mode || (m === 'some' && (a.length !== saved.length || a.some((e) => !saved.includes(e))));
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
            {set.map((e) => (
              <button key={e.key} type="button" class={'app-gm-emoji-btn' + (a.includes(e.key) ? ' is-on' : '')} aria-pressed={a.includes(e.key)} aria-label={'Реакция ' + e.key} onClick={() => toggle(e.key)}>
                {e.icon ? <img src={e.icon} alt="" draggable={false} decoding="async" /> : e.key}
              </button>
            ))}
          </div>
        </Section>
      ) : null}
    </GPage>
  );
}
