import { FOLDER_LIMITS, type ChatFolder } from '@relay/protocol';
import { Avatar, Icon, PanelHeader, ripple } from '@relay/ui';
import { useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import { back } from '../../nav';
import { showToast } from '../../settingsData';
import { chatTone } from '../format';
import { editDraft, EXCLUDE_TYPES, INCLUDE_TYPES, useDraft } from './FolderEdit';

/** Цвет круглого значка типа (как цветные иконки типов в Telegram). */
const TYPE_TONE: Record<string, string> = { contacts: 'blue', nonContacts: 'orange', groups: 'green', excludeMuted: 'gray', excludeRead: 'purple' };

/** Строка выбора: слева значок или аватар, справа одинаковая круглая галочка. */
function PickRow({ on, onToggle, lead, title, sub }: { on: boolean; onToggle(): void; lead: preact.ComponentChild; title: string; sub?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on ? 'true' : 'false'} class={'app-fpick-row' + (on ? ' app-fpick-on' : '')} onPointerDown={ripple} onClick={onToggle}>
      {lead}
      <span class="app-fpick-text"><span>{title}</span>{sub ? <small>{sub}</small> : null}</span>
      <span class="app-fpick-check" aria-hidden="true"><Icon name="check" size={14} strokeWidth={3} /></span>
    </button>
  );
}

/**
 * Выбор чатов и типов для папки: включённые (settings/folders/:id/include) или исключённые (…/exclude).
 * Правки сразу в черновике редактора — сохраняет галочка на странице папки. Чат, отмеченный здесь,
 * уходит из противоположного списка.
 */
export function FolderChats({ path }: { path: string }) {
  const kind = path.endsWith('/exclude') ? 'exclude' : 'include';
  const other = kind === 'include' ? 'exclude' : 'include';
  const draft = useDraft(path);
  const chats = useGlobal((s) => s.chats);
  const [q, setQ] = useState('');
  const title = kind === 'include' ? 'Добавить чаты' : 'Исключить чаты';
  if (!draft) return <div class="rl-sidepage"><PanelHeader icon="arrowLeft" closeLabel="Назад" title={title} onClose={() => void back()} /></div>;

  const f = draft.folder;
  const types = kind === 'include' ? INCLUDE_TYPES : EXCLUDE_TYPES;
  const picked = new Set(f[kind]);
  const needle = q.trim().toLowerCase();
  const nameOf = (c: Record<string, unknown>) => (c.title as string) || 'Чат №' + c.id;
  const byId = new Map(chats.map((c) => [c.id as number, c]));
  const list = needle ? chats.filter((c) => nameOf(c).toLowerCase().includes(needle)) : chats;
  const shownTypes = needle ? types.filter((t) => t.title.toLowerCase().includes(needle)) : types;

  const toggleChat = (id: number) => {
    if (picked.has(id)) { editDraft({ [kind]: f[kind].filter((x) => x !== id) }); return; }
    if (f[kind].length >= FOLDER_LIMITS.chats) { showToast('В папке может быть не больше 200 чатов'); return; }
    editDraft({ [kind]: [...f[kind], id], [other]: f[other].filter((x) => x !== id) });
  };
  const toggleType = (k: keyof ChatFolder) => editDraft({ [k]: !f[k] });
  const chips = [
    ...types.filter((t) => f[t.key]).map((t) => ({ key: t.key as string, label: t.title, onRemove: () => toggleType(t.key) })),
    ...f[kind].map((id) => ({ key: 'c' + id, label: nameOf(byId.get(id) ?? { id }), onRemove: () => toggleChat(id) })),
  ];
  const count = chips.length;

  return (
    <div class="rl-sidepage" aria-label={title}>
      <PanelHeader icon="arrowLeft" closeLabel="Готово" title={count ? `${title} · ${count}` : title} onClose={() => void back()} />
      <div class="app-fpick-top">
        <div class="app-fpick-field">
          {chips.map((c) => (
            <button key={c.key} type="button" class="app-fpick-chip" onClick={c.onRemove} aria-label={'Убрать ' + c.label}>
              <span>{c.label}</span><Icon name="close" size={14} />
            </button>
          ))}
          <input type="search" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} placeholder={count ? '' : 'Поиск чатов'} aria-label="Поиск чатов" autoComplete="off" />
        </div>
      </div>
      <div class="rl-page-scroll app-fpick">
        {shownTypes.length ? (
          <>
            <div class="app-fpick-caption">Типы чатов</div>
            {shownTypes.map((t) => (
              <PickRow key={t.key} on={!!f[t.key]} onToggle={() => toggleType(t.key)} title={t.title}
                lead={<span class={'app-fpick-tile app-fpick-tile-' + TYPE_TONE[t.key]} aria-hidden="true"><Icon name={t.icon} size={22} /></span>} />
            ))}
          </>
        ) : null}
        <div class="app-fpick-caption">Чаты</div>
        {list.length ? list.map((c) => (
          <PickRow key={c.id as number} on={picked.has(c.id as number)} onToggle={() => toggleChat(c.id as number)} title={nameOf(c)} sub={c.kind === 'group' ? 'группа' : 'личный чат'}
            lead={<Avatar name={nameOf(c)} tone={chatTone(c)} size={42} />} />
        )) : <div class="app-fpick-empty">{needle ? `Нет чатов по запросу «${q.trim()}»` : 'Чаты появятся здесь, когда загрузятся.'}</div>}
      </div>
    </div>
  );
}
