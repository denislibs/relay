// Папки в боковой панели: вкладки сверху (Sidebar) и колонка слева (App) читают одно и то же отсюда —
// список с бейджами, выбор папки, контекстное меню папки и где сейчас показываются вкладки.
import type { ChatFolder } from '@relay/protocol';
import { ConfirmDialog, FolderRail, MenuPopover } from '@relay/ui';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { seen } from '../data';
import { ALL, folderBadge, folderChats, folderIcon, type FolderChat, type FolderCtx } from '../folders';
import { getGlobal, setGlobal, useGlobal } from '../global';
import { isMuted } from '../mute';
import { go } from '../nav';
import { setPref } from '../prefs';
import { deleteFolder, showToast } from '../settingsData';

const WIDE = '(min-width: 926px)';   // уже — колонку прячет CSS, вкладки возвращаются наверх

/** Хватает ли ширины для колонки папок слева. */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof matchMedia === 'undefined' || matchMedia(WIDE).matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/** Где вкладки папок: нет своих папок — нигде (как в Telegram), иначе слева или сверху. */
export function useFolderPlace(): 'none' | 'top' | 'left' {
  const n = useGlobal((s) => s.settings.folders.length);
  const pos = useGlobal((s) => s.prefs.folders.position);
  const wide = useWide();
  return n === 0 ? 'none' : pos === 'left' && wide ? 'left' : 'top';
}

/** Контекст фильтра: контакты и заглушённые (на устройстве или умолчанием аккаунта для вида чата). */
export function useFolderCtx(): FolderCtx {
  const contacts = useGlobal((s) => s.contacts);
  const tick = useGlobal((s) => s.muteTick);   // истёк срок — пересчитать
  const notify = useGlobal((s) => s.settings.notify);
  return useMemo(() => {
    const ids = new Set<number>();
    for (const c of contacts) if (typeof c.userId === 'number') ids.add(c.userId);
    return { contacts: ids, isMuted: (c: FolderChat) => isMuted(c) || !!notify[c.kind]?.muted };
  }, [contacts, tick, notify]);
}

export interface FolderItem { id: number; label: string; count: number; muted: boolean; emoji?: string; icon?: string }

/** Вкладки: «Все» и свои папки по порядку, с бейджами непрочитанных чатов. */
export function useFolderItems(): FolderItem[] {
  const folders = useGlobal((s) => s.settings.folders);
  const chats = useGlobal((s) => s.chats) as unknown as FolderChat[];
  const ctx = useFolderCtx();
  return useMemo(() => [null, ...folders].map((f) => {
    const b = folderBadge(f, chats, ctx);
    const ic = folderIcon(f);
    return { id: f ? f.id : ALL, label: f ? f.title : 'Все чаты', count: b.count, muted: b.muted, ...ic };
  }), [folders, chats, ctx]);
}

/** Открыть папку; из настроек — сначала обратно к чатам (колонка слева видна и там). */
export function selectFolder(id: number): void {
  if (getGlobal().sidebarView !== 'chats') void go('chats');
  setGlobal({ folder: id });
}

/** Активная папка удалена (здесь или на другом устройстве) — назад к «Все». */
export function useFolderGuard(): void {
  const folder = useGlobal((s) => s.folder);
  const folders = useGlobal((s) => s.settings.folders);
  const loaded = useGlobal((s) => s.settings.loaded);
  useEffect(() => { if (folder !== ALL && loaded && !folders.some((f) => f.id === folder)) setGlobal({ folder: ALL }); }, [folder, folders, loaded]);
}

/** «Прочитать все»: каждый непрочитанный чат папки — до последнего сообщения. */
function readAll(f: ChatFolder | null, ctx: FolderCtx): void {
  const chats = folderChats(f, getGlobal().chats as unknown as (FolderChat & { last?: { id?: number | null } | null })[], ctx);
  for (const c of chats) if (c.unread > 0 && c.last?.id) seen(c.id, c.last.id);
}

type MenuAt = { x: number; y: number; id: number };

/** Контекстное меню папки (вкладка сверху или пункт колонки) и подтверждение удаления. */
export function useFolderMenu(): { open(id: number, e: MouseEvent): void; node: preact.JSX.Element } {
  const [at, setAt] = useState<MenuAt | null>(null);
  const [ask, setAsk] = useState<ChatFolder | null>(null);
  const folders = useGlobal((s) => s.settings.folders);
  const pos = useGlobal((s) => s.prefs.folders.position);
  const wide = useWide();
  const ctx = useFolderCtx();
  const items = useFolderItems();
  const f = at ? folders.find((x) => x.id === at.id) ?? null : null;
  const unread = at ? (items.find((x) => x.id === at.id)?.count ?? 0) > 0 : false;
  const close = () => setAt(null);
  const menu = at ? [
    f ? { icon: 'pencil', label: 'Изменить папку', onClick: () => { close(); void go('settings/folders/' + f.id); } }
      : { icon: 'folder', label: 'Изменить папки', onClick: () => { close(); void go('settings/folders'); } },
    ...(unread ? [{ icon: 'check', label: 'Прочитать все', onClick: () => { close(); readAll(f, ctx); } }] : []),
    ...(f ? [{ icon: 'trash', label: 'Удалить', danger: true, onClick: () => { close(); setAsk(f); } }] : []),
    ...(wide ? ['-' as const, { icon: 'listOrdered', label: pos === 'left' ? 'Вкладки сверху' : 'Вкладки слева', onClick: () => { close(); setPref('folders.position', pos === 'left' ? 'top' : 'left'); } }] : []),
  ] : [];
  const node = (
    <>
      <MenuPopover open={!!at} anchor={at ?? undefined} label={f ? 'Папка «' + f.title + '»' : 'Все чаты'} onClose={close} items={menu} />
      <ConfirmDialog
        open={!!ask}
        title="Удалить папку?"
        text={ask ? `Папка «${ask.title}» исчезнет на всех устройствах. Чаты останутся.` : ''}
        confirm="Удалить"
        danger
        onConfirm={() => { const id = ask!.id; setAsk(null); deleteFolder(id).catch(() => showToast('Не удалось удалить папку')); }}
        onCancel={() => setAsk(null)}
      />
    </>
  );
  return { open: (id, e) => setAt({ x: e.clientX, y: e.clientY, id }), node };
}

/** Колонка папок слева (FloatShell rail). */
export function FolderColumn() {
  const items = useFolderItems();
  const active = useGlobal((s) => s.folder);
  const menu = useFolderMenu();
  return (
    <>
      <FolderRail items={items} active={active} onChange={selectFolder} onItemMenu={menu.open} onSettings={() => void go('settings/folders')} settingsLabel="Настройки папок" />
      {menu.node}
    </>
  );
}
