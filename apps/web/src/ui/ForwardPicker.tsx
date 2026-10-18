import { ChatPicker } from '@relay/ui';
import type { ProfilePhoto } from '@relay/protocol';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { folderChats, type FolderChat } from '../folders';
import { closeForwardPick, forwardTo } from '../forward';
import { useGlobal } from '../global';
import { avatarPhoto } from '../profilePhoto';
import { topChats } from '../search';
import { useFolderCtx } from './folderNav';
import { chatTone, isSystemChat } from './format';

/** Окно «Переслать в…»: чаты, куда можно писать (без служебного «Relay» и тех, кого я заблокировал). */
export function ForwardPicker() {
  const pick = useGlobal((s) => s.fwdPick);
  const chats = useGlobal((s) => s.chats);
  const blocked = useGlobal((s) => s.blocked);
  const folders = useGlobal((s) => s.settings.folders);
  const ctx = useFolderCtx();
  const [top, setTop] = useState<number[]>([]);
  useEffect(() => { if (!pick) return; let live = true; void topChats().then((ids) => { if (live) setTop(ids); }); return () => { live = false; }; }, [!!pick]);

  const list = useMemo(() => chats.filter((c) => !isSystemChat(c) && !(c.kind === 'direct' && c.peerId != null && blocked.some((b) => b.userId === c.peerId))), [chats, blocked]);
  const items = useMemo(() => list.map((c) => ({
    id: c.id as number, title: (c.title as string) || 'Чат №' + c.id, tone: chatTone(c), avatar: avatarPhoto(c.photo as ProfilePhoto | null | undefined),
    subtitle: c.kind === 'group' ? 'группа' : undefined,
  })), [list]);
  const tabs = useMemo(() => folders.length ? [{ id: 'all', label: 'Все', ids: items.map((c) => c.id) },
    ...folders.map((f) => ({ id: String(f.id), label: f.title, ids: folderChats(f, list as unknown as FolderChat[], ctx).map((c) => c.id as number) }))] : [], [folders, list, ctx, items]);

  return <ChatPicker open={!!pick} onClose={closeForwardPick} title="Переслать в…" chats={items} top={top.filter((id) => items.some((c) => c.id === id))} folders={tabs}
    onSend={(ids: number[], comment: string) => { void forwardTo(ids, comment); }} />;
}
