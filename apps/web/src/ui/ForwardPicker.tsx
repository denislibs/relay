import { ChatPicker } from '@relay/ui';
import type { ProfilePhoto } from '@relay/protocol';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { folderChats, type FolderChat } from '../folders';
import { SAVED_TITLE } from '@relay/protocol';
import { closeForwardPick, forwardTo, SAVED_PICK } from '../forward';
import { useGlobal } from '../global';
import { avatarPhoto } from '../profilePhoto';
import { topChats, topChatsNow } from '../search';
import { useFolderCtx } from './folderNav';
import { chatTone, isSavedChat, isSystemChat } from './format';

/** Окно «Переслать в…»: чаты, куда можно писать (без служебного «Relay» и тех, кого я заблокировал). */
export function ForwardPicker() {
  const pick = useGlobal((s) => s.fwdPick);
  const chats = useGlobal((s) => s.chats);
  const blocked = useGlobal((s) => s.blocked);
  const folders = useGlobal((s) => s.settings.folders);
  const ctx = useFolderCtx();
  // частые — синхронно из кэша (окно открывается, когда они уже есть: forward.ts showPick), с первого кадра;
  // устаревший кэш обновится в фоне, и полоса перерисуется, только если ответ изменился
  const [, bump] = useState(0);
  const top = topChatsNow() ?? [];
  useEffect(() => { if (!pick) return; let live = true; void topChats().then((ids) => { if (live && ids !== top) bump((n) => n + 1); }); return () => { live = false; }; }, [!!pick]);

  const list = useMemo(() => chats.filter((c) => !isSystemChat(c) && !(c.kind === 'direct' && c.peerId != null && blocked.some((b) => b.userId === c.peerId))), [chats, blocked]);
  const items = useMemo(() => {
    const rows = list.filter((c) => !isSavedChat(c)).map((c) => ({
      id: c.id as number, title: (c.title as string) || 'Чат №' + c.id, tone: chatTone(c), avatar: avatarPhoto(c.photo as ProfilePhoto | null | undefined) as Record<string, unknown>,
      subtitle: c.kind === 'group' ? 'группа' : undefined,
    }));
    // «Избранное» — всегда первым; чата ещё нет или он глубже загруженного списка — строка с SAVED_PICK (forwardTo найдёт или создаст)
    const saved = list.find(isSavedChat);
    return [{ id: saved ? saved.id as number : SAVED_PICK, title: SAVED_TITLE, tone: undefined, avatar: { saved: true } as Record<string, unknown>, subtitle: undefined }, ...rows];
  }, [list]);
  const tabs = useMemo(() => folders.length ? [{ id: 'all', label: 'Все', ids: items.map((c) => c.id) },
    ...folders.map((f) => ({ id: String(f.id), label: f.title, ids: folderChats(f, list as unknown as FolderChat[], ctx).map((c) => c.id as number) }))] : [], [folders, list, ctx, items]);

  return <ChatPicker open={!!pick} onClose={closeForwardPick} title="Переслать в…" chats={items} top={top.filter((id) => items.some((c) => c.id === id))} folders={tabs}
    onSend={(ids: number[], comment: string) => { void forwardTo(ids, comment); }} />;
}
