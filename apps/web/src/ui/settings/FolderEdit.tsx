import { FOLDER_LIMITS, folderError, graphemes, nextFolderId, normalizeFolder, type ChatFolder } from '@relay/protocol';
import type { ProfilePhoto } from '@relay/protocol';
import { avatarPhoto } from '../../profilePhoto';
import { Avatar, ConfirmDialog, Fab, Icon, IconButton, InfoRow, PanelHeader, Presence, Section, Sticker, TextField } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getGlobal, setGlobal, useGlobal, type FolderDraft } from '../../global';
import { back, go, setLeaveGuard } from '../../nav';
import { deleteFolder, failText, saveFolder, showToast } from '../../settingsData';
import { chatTone, isSystemChat } from '../format';
import { FOLDER_EMOJI, FOLDER_ICONS } from '../../folders';

/** Иконки на выбор (как набор иконок папок в Telegram, плюс «без иконки» — по типу). */

export const INCLUDE_TYPES = [
  { key: 'contacts', icon: 'contact', title: 'Контакты' },
  { key: 'nonContacts', icon: 'account', title: 'Не контакты' },
  { key: 'groups', icon: 'community', title: 'Группы' },
] as const;
export const EXCLUDE_TYPES = [
  { key: 'excludeMuted', icon: 'bellOff', title: 'Без звука' },
  { key: 'excludeRead', icon: 'check', title: 'Прочитанные' },
] as const;

const blank = (id: number): ChatFolder => ({ id, title: '', emoji: null, include: [], exclude: [], contacts: false, nonContacts: false, groups: false, excludeMuted: false, excludeRead: false });
const same = (a: ChatFolder, b: ChatFolder) => JSON.stringify(normalizeFolder(a)) === JSON.stringify(normalizeFolder(b));
const SHOWN = 5;   // чатов в разделе до «Показать ещё»

/** Черновик для пути settings/folders/:id[/...]: заводит при первом заходе, держит между редактором и выбором чатов. */
export function useDraft(path: string): FolderDraft | null {
  const seg = path.split('/')[2];
  const folders = useGlobal((s) => s.settings.folders);
  const draft = useGlobal((s) => s.folderDraft);
  const isNew = seg === 'new';
  const id = isNew ? null : Number(seg);
  const existing = id === null ? null : folders.find((f) => f.id === id) ?? null;
  const fits = draft && (isNew ? draft.isNew : draft.id === id && !draft.isNew);
  useEffect(() => {
    if (fits) return;
    if (isNew) { const f = blank(nextFolderId(folders)); setGlobal({ folderDraft: { id: f.id, isNew: true, folder: f, original: f } }); }
    else if (existing) setGlobal({ folderDraft: { id: existing.id, isNew: false, folder: existing, original: existing } });
  }, [fits, isNew, existing]);
  return fits ? draft : null;
}

export const editDraft = (patch: Partial<ChatFolder>) => {
  const d = getGlobal().folderDraft;
  if (d) setGlobal({ folderDraft: { ...d, folder: { ...d.folder, ...patch } } });
};

/** Новая папка / правка: название и иконка, включённые и исключённые (типы и чаты), удаление. */
export function FolderEdit({ path }: { path: string }) {
  const draft = useDraft(path);
  const chats = useGlobal((s) => s.chats);
  const [more, setMore] = useState<{ include: boolean; exclude: boolean }>({ include: false, exclude: false });
  const [askLeave, setAskLeave] = useState<((ok: boolean) => void) | null>(null);
  const [askDelete, setAskDelete] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLDivElement>(null);
  const f = draft?.folder;
  const dirty = !!draft && (draft.isNew || !same(draft.folder, draft.original));
  const deeper = useRef(false);

  // уход с несохранёнными правками — «Сбросить изменения?»; переход к выбору чатов (вглубь) и возврат оттуда не спрашивают
  useEffect(() => {
    if (!dirty) { setLeaveGuard(null); return; }
    setLeaveGuard(() => {
      if (deeper.current) { deeper.current = false; return true; }
      if (getGlobal().sidebarView !== path) return true;
      return new Promise<boolean>((resolve) => setAskLeave(() => resolve));
    });
    return () => setLeaveGuard(null);
  }, [dirty, path]);
  useEffect(() => { if (draft?.isNew) setTimeout(() => input.current?.querySelector('input')?.focus({ preventScroll: true }), 300); }, [draft?.isNew]);

  if (!draft || !f) return <div class="rl-sidepage"><PanelHeader icon="arrowLeft" closeLabel="Назад" title="Папка" onClose={() => void back()} /></div>;

  const toChild = (kind: 'include' | 'exclude') => { deeper.current = true; void go(`${path}/${kind}`).finally(() => { deeper.current = false; }); };
  const leaveAnswer = (ok: boolean) => { askLeave?.(ok); setAskLeave(null); if (ok) setGlobal({ folderDraft: null }); };
  const byId = new Map(chats.map((c) => [c.id as number, c]));
  const chatRow = (id: number, list: 'include' | 'exclude') => {
    const c = byId.get(id);
    const name = (c?.title as string) || 'Чат №' + id;
    return (
      <div key={list + id} class="app-folder-chat">
        <Avatar name={name} tone={chatTone(c ?? { id })} size={40} logo={isSystemChat(c)} {...avatarPhoto(c?.photo as ProfilePhoto | null | undefined)} />
        <span class="rl-inforow-text"><span>{name}</span><small>{c?.kind === 'group' ? 'группа' : 'личный чат'}</small></span>
        <IconButton icon="close" label={'Убрать ' + name} onClick={() => editDraft({ [list]: f[list].filter((x) => x !== id) })} />
      </div>
    );
  };
  const typeRow = (t: { key: keyof ChatFolder; icon: string; title: string }) => (
    <div key={t.key} class="app-folder-chat">
      <span class="app-folder-type" aria-hidden="true"><Icon name={t.icon} size={22} /></span>
      <span class="rl-inforow-text"><span>{t.title}</span></span>
      <IconButton icon="close" label={'Убрать «' + t.title + '»'} onClick={() => editDraft({ [t.key]: false })} />
    </div>
  );
  const list = (kind: 'include' | 'exclude') => {
    const types = (kind === 'include' ? INCLUDE_TYPES : EXCLUDE_TYPES).filter((t) => f[t.key]);
    const rows = [...types.map((t) => typeRow(t)), ...f[kind].map((id) => chatRow(id, kind))];
    const open = more[kind] || rows.length <= SHOWN + 1;
    return (
      <>
        {open ? rows : rows.slice(0, SHOWN)}
        {!open ? <InfoRow icon="chevronDown" title={`Показать ещё ${rows.length - SHOWN}`} onClick={() => setMore({ ...more, [kind]: true })} /> : null}
      </>
    );
  };

  const save = () => {
    const n = normalizeFolder(f);
    const e = n ? folderError(n) : 'folder_title';
    if (!n || e) { setErr(failText(e!)); return; }
    setLeaveGuard(null);
    setGlobal({ folderDraft: null });
    saveFolder(n).catch(() => showToast('Не удалось сохранить папку'));
    void back();
  };
  const remove = () => {
    setAskDelete(false);
    setLeaveGuard(null);
    setGlobal({ folderDraft: null });
    deleteFolder(f.id).catch(() => showToast('Не удалось удалить папку'));
    void back();
  };
  const titleErr = err && err.startsWith('Укажите название') ? err : null;

  return (
    <div class="rl-sidepage" aria-label={draft.isNew ? 'Новая папка' : 'Изменить папку'}>
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title={draft.isNew ? 'Новая папка' : 'Изменить папку'} onClose={() => void back()} />
      <div class="rl-settings">
        <div class="app-folder-hero"><Sticker name="folderNew" size={100} replay="click" /></div>
        <Section title="Название папки">
          <div ref={input}>
            <TextField
              value={f.title} maxLength={FOLDER_LIMITS.title} measure={graphemes} counter={FOLDER_LIMITS.title - graphemes(f.title) <= Math.round(FOLDER_LIMITS.title / 3)} label="Название папки" error={titleErr ?? undefined}
              onInput={(v: string) => { setErr(null); editDraft({ title: v }); }}
              onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') save(); }}
            />
          </div>
          <div class="app-folder-emoji" role="radiogroup" aria-label="Иконка папки">
            <button type="button" role="radio" aria-checked={f.emoji === null ? 'true' : 'false'} class="app-folder-emoji-btn" title="По типу чатов" onClick={() => editDraft({ emoji: null })}><Icon name="folder" size={22} /></button>
            {FOLDER_EMOJI.map((e) => (
              <button key={e} type="button" role="radio" aria-checked={f.emoji === e ? 'true' : 'false'} aria-label={e} class="app-folder-emoji-btn" onClick={() => editDraft({ emoji: e })}><Icon name={FOLDER_ICONS[e]} size={22} /></button>
            ))}
          </div>
        </Section>
        <Section title="Включённые чаты" footer="Чаты и типы чатов, которые будут в этой папке.">
          <InfoRow icon="plus" title="Добавить чаты" onClick={() => toChild('include')} />
          {list('include')}
        </Section>
        <Section title="Исключённые чаты" footer="Этих чатов в папке не будет, даже если они подходят по типу.">
          <InfoRow icon="plus" title="Исключить чаты" onClick={() => toChild('exclude')} />
          {list('exclude')}
        </Section>
        {err && !titleErr ? <div class="app-folder-err" role="alert">{err}</div> : null}
        {!draft.isNew ? <Section><InfoRow icon="trash" danger title="Удалить папку" onClick={() => setAskDelete(true)} /></Section> : null}
      </div>
      <Presence show={dirty} exitMs={200}>
        <div class="rl-fab-slot"><Fab icon="check" label="Сохранить" onClick={save} /></div>
      </Presence>
      <ConfirmDialog open={!!askLeave} danger title="Сбросить изменения?" text="Правки папки не сохранятся." confirm="Сбросить" onCancel={() => leaveAnswer(false)} onConfirm={() => leaveAnswer(true)} />
      <ConfirmDialog open={askDelete} danger title="Удалить папку?" text={`Папка «${draft.original.title}» исчезнет на всех устройствах. Чаты останутся.`} confirm="Удалить" onCancel={() => setAskDelete(false)} onConfirm={remove} />
    </div>
  );
}
