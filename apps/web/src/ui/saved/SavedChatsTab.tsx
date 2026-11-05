// Вкладка «Чаты» панели «Избранного»: подчаты строками списка чатов, в карточке. Строка — ChatRow кита, как в левой колонке;
// список виртуальный, меню — у курсора (как у строки чата). Клик — кадр подчата поверх стека (openInner).
import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';
import type { ProfilePhoto } from '@relay/protocol';
import { asideFloats, ChatRow, confirmModal, EmptyState, MenuPopover, peerTone, WindowList } from '@relay/ui';
import { deleteSavedDialog, loadMoreSavedDialogs, openSavedDialog, openSavedSource, pinSavedDialog, prepareSavedDialog } from '../../data';
import { setGlobal } from '../../global';
import { avatarPhoto } from '../../profilePhoto';
import { canOpenSource, isHiddenPeer, isNotes, openSourceLabel, savedTitle, useSavedDialogs, type SavedItem } from '../../savedDialogs';
import { chatTime } from '../format';
import { pressOpen } from '../press';
import { previewBody, previewThumb, type LastMessage } from '../preview';

const ROW = 72;   // --size-row

/** Открыть подчат; панель лежит поверх чата (места рядом нет) — закрывается, иначе переход не виден. */
function openRow(chatId: number, peer: string): void {
  const floats = asideFloats();
  openSavedDialog(chatId, peer, floats);
  if (floats) setGlobal({ infoOpen: false });
}

const SavedRow = memo(function SavedRow({ d, chatId, onMenu }: { d: SavedItem; chatId: number; onMenu: (d: SavedItem, x: number, y: number) => void }) {
  const last = d.last as (LastMessage & { fwd?: boolean }) | null;
  const thumb = last ? previewThumb(last) : null;
  const a = avatarPhoto(d.photo as ProfilePhoto | null);
  const id = Number(d.peer.slice(1));
  return (
    <ChatRow
      data-saved-peer={d.peer}
      name={savedTitle(d)}
      glyph={isNotes(d.peer) ? 'notes' : isHiddenPeer(d.peer) ? 'hidden' : undefined}
      avatarTone={Number.isFinite(id) ? peerTone(id) : undefined}
      avatarSrc={a.src}
      avatarThumb={a.thumb}
      thumb={thumb}
      forwarded={!!last?.fwd && !last.deleted && !isNotes(d.peer)}
      preview={last ? previewBody(last, !!thumb) : ''}
      time={chatTime(d.createdAt ?? undefined)}
      pinned={d.pinnedAt != null}
      {...pressOpen(() => (asideFloats() ? null : prepareSavedDialog(chatId, d.peer)), () => openRow(chatId, d.peer))}
      onContextMenu={(e: MouseEvent) => { e.preventDefault(); onMenu(d, e.clientX, e.clientY); }}
    />
  );
});

export function SavedChatsTab({ chatId }: { chatId: number }) {
  const { items, meta } = useSavedDialogs();
  const [menu, setMenu] = useState<{ d: SavedItem; x: number; y: number } | null>(null);
  const onMenu = useState(() => (d: SavedItem, x: number, y: number) => setMenu({ d, x, y }))[0];
  if (!items.length) {
    // сервер ещё не ответил (первое открытие онлайн) — пусто без надписи: строки встанут сами; пусто по правде — подпись
    if (!meta?.loaded) return null;
    return <EmptyState title="Здесь пока пусто" text="Пересланные сюда сообщения и ваши заметки появятся в этом списке" />;
  }
  const d = menu?.d;
  return (
    <div class="rl-aside-group app-saved-list">
      <WindowList items={items} rowHeight={ROW} overscan={6} getKey={(x: SavedItem) => x.peer} onNearEnd={meta?.done ? undefined : loadMoreSavedDialogs} nearEndKey={String(items.length)}
        render={(x: SavedItem) => <SavedRow d={x} chatId={chatId} onMenu={onMenu} />} />
      <MenuPopover open={!!menu} anchor={menu ?? undefined} label="Действия с чатом" onClose={() => setMenu(null)}
        items={d ? [
          { icon: d.pinnedAt != null ? 'unpin' : 'pin', label: d.pinnedAt != null ? 'Открепить' : 'Закрепить', onClick: () => { setMenu(null); void pinSavedDialog(d.peer, d.pinnedAt == null); } },
          ...(canOpenSource(d) ? [{ icon: d.kind === 'channel' ? 'channels' : d.kind === 'group' ? 'community' : 'chats', label: openSourceLabel(d), onClick: () => { setMenu(null); openSavedSource(d); if (asideFloats()) setGlobal({ infoOpen: false }); } }] : []),
          '-' as const,
          { icon: 'trash', label: 'Удалить', danger: true, onClick: () => { setMenu(null); askDeleteSaved(d); } },
        ] : []} />
    </div>
  );
}

/** Подтверждение: стираются все сообщения подчата, как при обычном удалении. */
export function askDeleteSaved(d: SavedItem, done?: () => void): void {
  void confirmModal({ title: `Удалить «${savedTitle(d)}»?`, text: 'Все сообщения этого чата будут удалены из «Избранного» на всех устройствах. Это действие нельзя отменить.', confirm: 'Удалить', danger: true })
    .then((ok: boolean) => { if (ok) { void deleteSavedDialog(d.peer); done?.(); } });
}
