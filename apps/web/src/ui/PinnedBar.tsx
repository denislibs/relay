import { hideSpoilers } from '@relay/protocol';
import { ConfirmDialog, Icon, IconButton, Menu, Presence } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { useEffect, useState } from 'preact/hooks';
import { focusMessage, messagesByIds, unpinMessage } from '../data';
import { activeFrame, useGlobal } from '../global';
import { previewBody, previewThumb, type LastMessage } from './preview';

// Закреплённые сообщения под шапкой — как в Telegram: слева полоска из сегментов (по числу закреплённых),
// «Закреплённое сообщение #N» и строка текста; клик — к сообщению и следующий клик — к более старому (по кругу).
// Одно закреплённое — крестик «открепить»; несколько — список всех и «Открепить все».

const KIND: Record<string, string> = { photo: 'Фото', file: 'Файл', audio: 'Музыка', voice: 'Голосовое сообщение', round: 'Видеосообщение' };
const cache = new Map<string, Item>();          // chatId:id → сообщение (если его нет в загруженной ленте)
const position = new Map<number, number>();     // чат → какой из закреплённых показан

export function PinnedBar({ chatId }: { chatId: number }) {
  const pinned = useGlobal((s) => (s.chats.find((c) => c.id === chatId)?.pinned as number[] | undefined) ?? []);
  const loaded = useGlobal((s) => activeFrame(s)?.messages);
  const [, rerender] = useState(0);
  const [idx, setIdx] = useState(() => position.get(chatId) ?? 0);
  const [list, setList] = useState(false);
  const [ask, setAsk] = useState<number | 'all' | null>(null);
  useEffect(() => { setIdx(position.get(chatId) ?? 0); setList(false); }, [chatId]);
  const i = pinned.length ? Math.min(idx, pinned.length - 1) : 0;
  const id = pinned[i];
  const find = (mid: number) => loaded?.find((m) => m.id === mid) ?? cache.get(chatId + ':' + mid);
  // тексты закреплённых, которых нет в ленте, — одним запросом
  useEffect(() => {
    const want = pinned.filter((x) => !find(x));
    if (!want.length) return;
    let live = true;
    messagesByIds(chatId, want).then((ms) => { for (const m of ms) cache.set(chatId + ':' + m.id, m); if (live) rerender((n) => n + 1); }).catch(() => {});
    return () => { live = false; };
  }, [chatId, pinned.join(',')]);
  const msg = id != null ? find(id) : undefined;

  const go = () => {
    if (id == null) return;
    focusMessage({ id, sort: id });
    const next = (i + 1) % pinned.length;   // следующий клик — к более старому, после самого старого — снова к новому
    position.set(chatId, next); setIdx(next);
  };
  const n = pinned.length;
  const seg = n <= 1 ? 36 : n === 2 ? 17 : n === 3 ? 11 : 7.5;   // высоты сегментов, как в Telegram
  const shift = n > 4 ? Math.max(0, Math.min(i - 1, n - 4)) * (seg + 2) : 0;
  const thumb = msg ? previewThumb(msg as unknown as LastMessage) : null;
  return (
    <Presence show={n > 0} exitMs={220}>
      <div class="app-pins" role="region" aria-label="Закреплённые сообщения">
        <button type="button" class="app-pins-main" onClick={go}>
          <span class="app-pins-track" aria-hidden="true">
            <span class="app-pins-segs" style={{ transform: `translateY(${-shift}px)` }}>
              {pinned.map((p, k) => <i key={p} class={k === i ? 'app-pins-on' : ''} style={{ height: seg + 'px' }} />)}
            </span>
          </span>
          {thumb ? <img class="app-pins-thumb" src={thumb.src} alt="" /> : null}
          <span class="app-pins-text">
            <b>{n > 1 ? `Закреплённое сообщение #${n - i}` : 'Закреплённое сообщение'}</b>
            <span key={id}>{msg ? previewBody(msg as unknown as LastMessage, !!thumb) : '…'}</span>
          </span>
        </button>
        {n > 1
          ? <IconButton icon="list" label="Все закреплённые" onClick={() => setList(!list)} />
          : <IconButton icon="close" label="Открепить" onClick={() => setAsk(id)} />}
        {list ? (
          <div class="app-pins-list">
            <div class="rl-recmode-scrim" onClick={() => setList(false)} />
            <Menu label="Закреплённые сообщения" onClose={() => setList(false)} items={[
              ...pinned.map((p, k) => {
                const m = find(p);
                const text = m ? (hideSpoilers(String(m.body ?? ''), m.entities as never).replace(/\s+/g, ' ').trim() || KIND[String(m.kind)] || 'Сообщение').slice(0, 60) : 'Сообщение';
                return { icon: 'pin', label: text, onClick: () => { setList(false); position.set(chatId, k); setIdx(k); focusMessage({ id: p, sort: p }); } };
              }),
              '-' as const,
              { icon: 'close', label: 'Открепить все', danger: true, onClick: () => { setList(false); setAsk('all'); } },
            ]} />
          </div>
        ) : null}
        <ConfirmDialog open={ask != null} danger title={ask === 'all' ? 'Открепить все сообщения?' : 'Открепить сообщение?'}
          text={ask === 'all' ? 'Все закреплённые сообщения этого чата будут откреплены у всех участников.' : 'Сообщение будет откреплено у всех участников чата.'}
          confirm="Открепить" cancel="Отмена" onCancel={() => setAsk(null)}
          onConfirm={() => { const what = ask; setAsk(null); position.set(chatId, 0); setIdx(0); void unpinMessage(chatId, what === 'all' ? null : (what as number)); }} />
      </div>
    </Presence>
  );
}
