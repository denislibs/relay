import { hideSpoilers } from '@relay/protocol';
import { ConfirmDialog, Icon, IconButton, MenuPopover, Presence } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { useEffect, useState } from 'preact/hooks';
import { focusMessage, messagesByIds, unpinMessage } from '../data';
import { activeFrame, useGlobal } from '../global';
import { asLast, previewBody, previewThumb, thumbUnder } from './preview';

// Закреплённые сообщения под шапкой — как в Telegram: слева полоска из сегментов (по числу закреплённых),
// «Закреплённое сообщение #N» и строка текста; клик — к сообщению и следующий клик — к более старому (по кругу).
// Одно закреплённое — крестик «открепить»; несколько — список всех и «Открепить все».

const KIND: Record<string, string> = { photo: 'Фото', file: 'Файл', audio: 'Музыка', voice: 'Голосовое сообщение', round: 'Видеосообщение' };
/** Музыка в списке закреплённых: «название — исполнитель», как в превью. */
const trackOf = (m: Item) => { const a = m.attachment as { title?: string | null; performer?: string | null; name?: string } | null; if (m.kind !== 'audio' || !a) return ''; const t = a.title || (a.name ?? '').replace(/\.[^.]{1,5}$/, ''); return a.performer ? t + ' — ' + a.performer : t; };
const cache = new Map<string, Item>();          // chatId:id → сообщение (если его нет в загруженной ленте)
const position = new Map<number, number>();     // чат → какой из закреплённых показан

export function PinnedBar({ chatId }: { chatId: number }) {
  const pinned = useGlobal((s) => (s.chats.find((c) => c.id === chatId)?.pinned as number[] | undefined) ?? []);
  const loaded = useGlobal((s) => activeFrame(s)?.messages);
  const [, rerender] = useState(0);
  const [idx, setIdx] = useState(() => position.get(chatId) ?? 0);
  const [list, setList] = useState<HTMLElement | null>(null);
  const [ask, setAsk] = useState<number | 'all' | null>(null);
  useEffect(() => { setIdx(position.get(chatId) ?? 0); setList(null); }, [chatId]);
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
  const last = msg ? asLast(msg) : null;   // вложение у сообщения ленты — объектом, превью ждёт плоские поля
  const thumb = last ? previewThumb(last) : null;
  return (
    <Presence show={n > 0} exitMs={220}>
      <div class="app-pins" role="region" aria-label="Закреплённые сообщения">
        <button type="button" class="app-pins-main" onClick={go}>
          <span class="app-pins-track" aria-hidden="true">
            <span class="app-pins-segs" style={{ transform: `translateY(${-shift}px)` }}>
              {pinned.map((p, k) => <i key={p} class={k === i ? 'app-pins-on' : ''} style={{ height: seg + 'px' }} />)}
            </span>
          </span>
          {thumb ? <img class={'app-pins-thumb' + (thumb.round ? ' app-pins-thumb-round' : '')} src={thumb.full ?? thumb.src} style={thumb.full ? thumbUnder(thumb.src) : undefined} decoding="async" alt="" /> : null}
          <span class="app-pins-text">
            <b>{n > 1 ? `Закреплённое сообщение #${n - i}` : 'Закреплённое сообщение'}</b>
            <span key={id}>{last ? previewBody(last, !!thumb) : '…'}</span>
          </span>
        </button>
        {n > 1
          ? <IconButton icon="list" label="Все закреплённые" onClick={(e: MouseEvent) => setList(list ? null : e.currentTarget as HTMLElement)} />
          : <IconButton icon="close" label="Открепить" onClick={() => setAsk(id)} />}
        <MenuPopover open={!!list} anchor={list ?? undefined} placement="bottom-end" class="app-pins-list" label="Закреплённые сообщения" onClose={() => setList(null)} items={[
              ...pinned.map((p, k) => {
                const m = find(p);
                const text = m ? (hideSpoilers(String(m.body ?? ''), m.entities as never).replace(/\s+/g, ' ').trim() || trackOf(m) || KIND[String(m.kind)] || 'Сообщение').slice(0, 60) : 'Сообщение';
                return { icon: 'pin', label: text, onClick: () => { setList(null); position.set(chatId, k); setIdx(k); focusMessage({ id: p, sort: p }); } };
              }),
              '-' as const,
              { icon: 'close', label: 'Открепить все', danger: true, onClick: () => { setList(null); setAsk('all'); } },
            ]} />
        <ConfirmDialog open={ask != null} danger title={ask === 'all' ? 'Открепить все сообщения?' : 'Открепить сообщение?'}
          text={ask === 'all' ? 'Все закреплённые сообщения этого чата будут откреплены у всех участников.' : 'Сообщение будет откреплено у всех участников чата.'}
          confirm="Открепить" cancel="Отмена" onCancel={() => setAsk(null)}
          onConfirm={() => { const what = ask; setAsk(null); position.set(chatId, 0); setIdx(0); void unpinMessage(chatId, what === 'all' ? null : (what as number)); }} />
      </div>
    </Presence>
  );
}
