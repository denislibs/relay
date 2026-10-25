import type { Poll } from '@relay/protocol';
import { Avatar, Modal, peerTone, pollShares } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { openUserChat, pollVoters } from '../data';
import { getGlobal, setGlobal, useGlobal } from '../global';
import { senderAvatar } from '../profilePhoto';

/**
 * «Результаты» неанонимного опроса, как в Telegram: по вариантам — доля, число голосов и кто голосовал.
 * Список голосовавших грузится по открытию; пока его нет — только доли (они уже есть в сообщении).
 */
export function PollResults() {
  const at = useGlobal((s) => s.pollResults);
  // сообщение — из открытых лент (итоги живые: новые голоса меняют доли и здесь)
  const msg = useGlobal((s) => s.pollResults ? s.chatStack.flatMap((f) => f.chatId === s.pollResults!.chatId ? f.messages : []).find((m) => m.id === s.pollResults!.id) : undefined);
  const [voters, setVoters] = useState<{ option: number; users: { id: number; name: string }[] }[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setVoters(null); setFailed(false);
    if (!at) return;
    let live = true;
    pollVoters(at.chatId, at.id).then((v) => { if (live) setVoters(v); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [at?.chatId, at?.id]);
  if (!at) return null;
  const poll = msg?.poll as Poll | undefined;
  if (!poll) return null;
  const close = () => setGlobal({ pollResults: null });
  const shares = pollShares(poll.counts);
  const meId = getGlobal().me?.userId;
  return (
    <Modal size="slim" title={poll.quiz ? 'Результаты викторины' : 'Результаты опроса'} onClose={close} class="app-pollres">
      <p class="app-pollres-q">{poll.question}</p>
      {poll.options.map((o, i) => {
        const users = voters?.find((v) => v.option === o.id)?.users ?? [];
        return (
          <section key={o.id} class="app-pollres-opt">
            <header>
              <span class="app-pollres-text">{o.text}{poll.quiz && poll.correct === o.id ? ' ✓' : ''}</span>
              <span class="app-pollres-pct">{shares[i]}% · {poll.counts[i]}</span>
            </header>
            {voters ? users.map((u) => (
              <button type="button" key={u.id} class="app-pollres-user" onClick={() => { close(); if (u.id !== meId) openUserChat(u.id); }}>
                <Avatar name={u.name} tone={peerTone(u.id)} size={32} {...senderAvatar(u.id)} />
                <span>{u.id === meId ? 'Вы' : u.name}</span>
              </button>
            )) : null}
          </section>
        );
      })}
      {failed ? <p class="app-pollres-note">Не удалось загрузить список проголосовавших</p> : null}
    </Modal>
  );
}
