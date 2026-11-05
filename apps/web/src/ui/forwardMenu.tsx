import { Avatar } from '@relay/ui';
import { SAVED_TITLE, type ProfilePhoto } from '@relay/protocol';
import type { Item } from '@relay/sync-engine/src/types';
import type { ChatFolder } from '@relay/protocol';
import { folderChats, type FolderChat, type FolderCtx } from '../folders';
import { SAVED_PICK } from '../forward';
import { avatarPhoto } from '../profilePhoto';
import { topChatsNow } from '../search';
import { chatTone, isSavedChat, isSystemChat } from './format';

// Подменю «Переслать» у сообщения, как в Telegram: «Избранное», частые и недавние чаты, «Папки» со своими чатами
// и «Ещё…» — полное окно выбора. Клик по чату — пересылка сразу (forward.ts forwardQuick). Чаты те же, что в окне
// выбора: без служебного «Relay» и тех, кого я заблокировал.

const RECENT = 6;        // частых и недавних в подменю
const PER_FOLDER = 15;   // чатов в подменю папки (остальные — через «Ещё…»)

type MenuItem = { key?: string; icon?: string; leading?: unknown; label: string; onClick?: () => void; submenu?: (MenuItem | '-')[] } | '-';

export function forwardSubmenu(o: {
  chats: Item[]; blocked: Item[]; folders: ChatFolder[]; ctx: FolderCtx;
  onPick: (to: number, title: string) => void; onMore: () => void;
}): MenuItem[] {
  const list = o.chats.filter((c) => !isSystemChat(c) && !(c.kind === 'direct' && c.peerId != null && o.blocked.some((b) => b.userId === c.peerId)));
  const row = (c: Item): MenuItem => {
    const title = (c.title as string) || 'Чат №' + c.id;
    return { key: 'c' + c.id, label: title, leading: <Avatar name={title} tone={chatTone(c)} size={24} {...avatarPhoto(c.photo as ProfilePhoto | null | undefined)} />, onClick: () => o.onPick(c.id as number, title) };
  };
  const saved = list.find(isSavedChat);
  const rest = list.filter((c) => !isSavedChat(c));
  // частые собеседники (кэш движка, синхронно), дальше — недавние по списку чатов
  const byId = new Map(rest.map((c) => [c.id as number, c]));
  const recent: Item[] = [];
  for (const id of topChatsNow() ?? []) { const c = byId.get(id); if (c && recent.length < RECENT) recent.push(c); }
  for (const c of rest) { if (recent.length >= RECENT) break; if (!recent.includes(c)) recent.push(c); }
  const folders = o.folders
    .map((f) => ({ f, chats: folderChats(f, rest as unknown as FolderChat[], o.ctx).slice(0, PER_FOLDER) as unknown as Item[] }))
    .filter((x) => x.chats.length);
  return [
    { key: 'saved', label: SAVED_TITLE, leading: <Avatar name={SAVED_TITLE} saved size={24} />, onClick: () => o.onPick(saved ? saved.id as number : SAVED_PICK, SAVED_TITLE) },
    ...(recent.length ? ['-' as const, ...recent.map(row)] : []),
    '-',
    ...(folders.length ? [{ key: 'folders', icon: 'folder', label: 'Папки', submenu: folders.map(({ f, chats }) => ({ key: 'f' + f.id, icon: 'folder', label: f.title, submenu: chats.map(row) })) }] : []),
    { key: 'more', icon: 'more', label: 'Ещё…', onClick: o.onMore },
  ];
}
