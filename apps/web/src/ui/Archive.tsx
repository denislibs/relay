import { EmptyState, PanelHeader, WindowList } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { useRef, useState } from 'preact/hooks';
import { isArchived } from '../chatFlags';
import { useGlobal } from '../global';
import { isMuted } from '../mute';
import { back } from '../nav';
import { RowMenu, SideRow } from './Sidebar';

const ROW = 72;

/**
 * «Архив» — страница слева, как в Telegram: свой список (закреплённые в архиве — сверху, в порядке движка),
 * те же строки и то же меню, что в «Все» (там пункт «Вернуть из архива»). Новое сообщение в незаглушённый
 * архивный чат возвращает его в «Все» само (сервер).
 */
export function Archive() {
  const me = useGlobal((s) => s.me)!;
  const chats = useGlobal((s) => s.chats);
  const openId = useGlobal((s) => s.pendingChatId ?? s.openChatId);
  const list = chats.filter(isArchived);
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const onMenu = useRef((id: number, x: number, y: number) => setMenu({ id, x, y })).current;
  return (
    <div class="rl-sidepage" aria-label="Архив">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Архив" onClose={() => void back()} />
      <div class="rl-page-scroll">
        <div class="app-listwrap">
          {list.length ? (
            <WindowList keepAlive overscanPx={900} role="list" items={list} rowHeight={ROW} getKey={(c: Item) => 'c' + c.id}
              render={(c: Item) => <SideRow c={c} meId={me.userId} active={c.id === openId} showDraft={!!c.draft && c.id !== openId} muted={isMuted(c)} onMenu={onMenu} />} />
          ) : (
            <EmptyState kind="chats" title="Архив пуст" text="Сюда можно убрать чаты, которые не нужны в основном списке: «В архив» в меню чата." />
          )}
        </div>
      </div>
      <RowMenu at={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
