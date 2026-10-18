import { FOLDER_LIMITS, nextFolderId, type ChatFolder } from '@relay/protocol';
import { Button, ConfirmDialog, Icon, IconButton, InfoRow, PanelHeader, RadioRow, Section, Sticker } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { folderChats, folderIcon, folderSubtitle, moveItem, recommendedFor, type FolderChat } from '../../folders';
import { getGlobal, setGlobal, useGlobal } from '../../global';
import { back, go } from '../../nav';
import { setPref } from '../../prefs';
import { deleteFolder, reorderFolders, saveFolder, showToast } from '../../settingsData';
import { useFolderCtx, useWide } from '../folderNav';
import { dropIndex, shiftFor } from '../links/linkList';

type Drag = { from: number; to: number; dy: number; rowH: number; y0: number; id: number };

/** Иконка папки в строке: эмодзи или значок типа. */
export function FolderGlyph({ f, size = 26 }: { f: ChatFolder | null; size?: number }) {
  const ic = folderIcon(f);
  return 'emoji' in ic
    ? <span class="app-folder-glyph" style={{ fontSize: size - 2 + 'px' }} aria-hidden="true">{ic.emoji}</span>
    : <span class="app-folder-glyph" aria-hidden="true"><Icon name={ic.icon} size={size} /></span>;
}

/** Настройки → «Папки с чатами»: создать, порядок перетаскиванием (и Alt+↑/↓), рекомендуемые, вид вкладок. */
export function Folders() {
  const folders = useGlobal((s) => s.settings.folders);
  const chats = useGlobal((s) => s.chats) as unknown as FolderChat[];
  const pos = useGlobal((s) => s.prefs.folders.position);
  const view = useGlobal((s) => s.sidebarView);
  // вернулись к списку — черновик редактора больше не нужен (следующая правка начнётся с того, что на сервере)
  useEffect(() => { if (view === 'settings/folders' && getGlobal().folderDraft) setGlobal({ folderDraft: null }); }, [view]);
  const wide = useWide();
  const ctx = useFolderCtx();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [settling, setSettling] = useState(false);
  const [ask, setAsk] = useState<ChatFolder | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const full = folders.length >= FOLDER_LIMITS.folders;
  const recs = recommendedFor(folders);

  const create = () => (full ? showToast('Можно создать не больше 10 папок') : void go('settings/folders/new'));
  const reorder = (from: number, to: number) => { reorderFolders(moveItem(folders, from, to).map((f) => f.id)).catch(() => showToast('Не удалось сохранить порядок')); };

  const onDown = (i: number) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    const row = (e.currentTarget as HTMLElement).closest('.app-link-row') as HTMLElement;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
    setDrag({ from: i, to: i, dy: 0, rowH: row.getBoundingClientRect().height, y0: e.clientY, id: e.pointerId });
  };
  const onMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id) return;
    const dy = Math.max(-d.from * d.rowH, Math.min((folders.length - 1 - d.from) * d.rowH, e.clientY - d.y0));
    setDrag({ ...d, dy, to: dropIndex(d.from, dy, d.rowH, folders.length) });
  };
  const onUp = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id) return;
    setDrag(null);
    if (d.to !== d.from) {
      // новый порядок встаёт без анимации: строки уже на местах, иначе соседи «отъедут» обратно
      setSettling(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
      reorder(d.from, d.to);
    }
  };
  const onKey = (i: number) => (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const to = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= folders.length) return;
    reorder(i, to);
    const host = (e.currentTarget as HTMLElement).parentElement?.parentElement;
    requestAnimationFrame(() => (host?.querySelectorAll<HTMLElement>('.app-link-open')[to])?.focus());
  };

  return (
    <div class="rl-sidepage" aria-label="Папки с чатами">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Папки с чатами" onClose={() => void back()} />
      <div class="rl-settings">
        <div class="app-folders-intro">
          <Sticker name="folder" size={100} replay="click" />
          <p>Создавайте папки для разных групп чатов и быстро переключайтесь между ними.</p>
          <Button variant="primary" onClick={create}><Icon name="plus" size={20} /> Создать папку</Button>
        </div>

        <Section title="Папки" footer={folders.length > 1 ? 'Перетащите папку за ручку справа, чтобы поменять порядок вкладок.' : undefined}>
          <InfoRow icon="chats" title="Все чаты" subtitle="Все чаты без исключений" />
          <div class={'app-links-list' + (drag ? ' app-links-dragging' : '') + (settling ? ' app-links-settling' : '')} role="list" aria-label="Свои папки">
            {folders.map((f, i) => {
              const dragging = drag?.from === i;
              const shift = drag && !dragging ? shiftFor(i, drag.from, drag.to) * drag.rowH : 0;
              return (
                <div key={f.id} role="listitem" class={'app-link-row' + (dragging ? ' app-link-row-drag' : '')}
                  style={{ transform: dragging ? `translateY(${drag!.dy}px)` : shift ? `translateY(${shift}px)` : undefined }}>
                  <button type="button" class="app-link-open" onClick={() => void go('settings/folders/' + f.id)} onKeyDown={onKey(i)} aria-label={`Папка «${f.title}». Изменить`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">
                    <FolderGlyph f={f} />
                    <span class="rl-inforow-text"><span>{f.title}</span><small>{folderSubtitle(f, folderChats(f, chats, ctx).length)}</small></span>
                  </button>
                  <IconButton icon="trash" label={`Удалить папку «${f.title}»`} onClick={() => setAsk(f)} />
                  {folders.length > 1 ? (
                    <span class="app-link-grip" title="Перетащите, чтобы поменять порядок" aria-hidden="true" onPointerDown={onDown(i)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
                      <Icon name="grip" size={22} />
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          {!folders.length ? <div class="app-folders-none">Своих папок пока нет.</div> : null}
        </Section>

        {recs.length && !full ? (
          <Section title="Рекомендуемые папки">
            {recs.map((r) => (
              <div key={r.key} class="app-folder-rec">
                <span class="rl-inforow-text"><span>{r.folder.title}</span><small>{r.description}</small></span>
                <Button variant="primary" class="rl-btn-tiny" onClick={() => saveFolder({ ...r.folder, id: nextFolderId(folders) }).catch(() => showToast('Не удалось добавить папку'))}>Добавить</Button>
              </div>
            ))}
          </Section>
        ) : null}

        <Section title="Вид вкладок" role="radiogroup" footer={wide ? undefined : 'На узком окне вкладки всегда сверху.'}>
          <RadioRow checked={pos === 'left'} label="Слева" subtitle="Колонкой рядом со списком чатов" onClick={() => setPref('folders.position', 'left')} />
          <RadioRow checked={pos === 'top'} label="Сверху" subtitle="Полосой над списком чатов" onClick={() => setPref('folders.position', 'top')} />
        </Section>
      </div>
      <ConfirmDialog
        open={!!ask} danger title="Удалить папку?" confirm="Удалить"
        text={ask ? `Папка «${ask.title}» исчезнет на всех устройствах. Чаты останутся.` : ''}
        onCancel={() => setAsk(null)}
        onConfirm={() => { const id = ask!.id; setAsk(null); deleteFolder(id).catch(() => showToast('Не удалось удалить папку')); }}
      />
    </div>
  );
}
