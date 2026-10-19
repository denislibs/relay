// Развёрнутое поле ввода — «статья», как в Telegram Web: карточка поля растёт вверх до шапки (лента под ней),
// сверху — Отменить/Вернуть и «Свернуть», снизу — панель: «+» (заголовки, цитата, разделитель), списки, ссылка, код,
// отправить. Ядро редактора (Tiptap) — отдельный бандл /articleEditor.js, грузится при первом развороте.
// Ctrl/Cmd+Enter — отправить, Esc — свернуть.
import { IconButton, MenuPopover, Modal, Button, TextField, reducedMotion } from '@relay/ui';

const CLOSE_MS = 260;
import type { Block } from '@relay/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';

type EdState = { canUndo: boolean; canRedo: boolean; empty: boolean; active: Record<string, boolean> };
type Ed = {
  getBlocks(): Block[]; setBlocks(b: Block[]): void; state(): EdState; focus(): void; destroy(): void;
  heading(l: 1 | 2 | 3): void; paragraph(): void; bulletList(): void; orderedList(): void; quote(): void; codeBlock(): void; divider(): void;
  link(url: string, text?: string): void; undo(): void; redo(): void;
};
type Mod = { createArticleEditor(o: { element: HTMLElement; blocks?: Block[]; placeholder?: string; onUpdate?(s: EdState): void; onSubmit?(): void; onEscape?(): void }): Ed };

let modP: Promise<Mod> | null = null;
/** Ядро редактора — лениво, один раз (адрес — не литерал: сборщик не втягивает его в основной бандл). */
function loadEditor(): Promise<Mod> {
  const url = '/articleEditor.js';
  return (modP ??= (import(/* @vite-ignore */ url) as Promise<Mod>).catch((e) => { modP = null; throw e; }));
}
export const preloadArticleEditor = () => { void loadEditor().catch(() => {}); };

export function ArticleComposer({ blocks, onCollapse, onSend, onClosing }: { blocks: Block[]; onCollapse: (b: Block[]) => void; onSend: (b: Block[]) => void; onClosing?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<Ed | null>(null);
  const [st, setSt] = useState<EdState>({ canUndo: false, canRedo: false, empty: true, active: {} });
  const [menu, setMenu] = useState<{ kind: 'insert' | 'lists'; el: HTMLElement } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const cbs = useRef({ onCollapse, onSend }); cbs.current = { onCollapse, onSend };

  useEffect(() => {
    let alive = true;
    (document.activeElement as HTMLElement | null)?.blur?.();   // поле ввода под карточкой — без фокуса
    loadEditor().then((m) => {
      if (!alive || !host.current) return;
      ed.current = m.createArticleEditor({
        element: host.current, blocks, placeholder: 'Сообщение',
        onUpdate: (s) => setSt(s),
        onSubmit: () => send(),
        onEscape: () => collapse(),
      });
      // фокус — в редактор: поле ввода под карточкой (очистка черновика, меню скрепки) забирает его обратно
      // в ближайшие кадры — несколько раз возвращаем, пока не устоится (только если фокус ушёл не в саму карточку)
      const grab = () => { if (alive && host.current && !host.current.parentElement?.closest('.app-art')?.contains(document.activeElement)) ed.current?.focus(); };
      for (const ms of [0, 60, 160, 320]) setTimeout(grab, ms);
    }, () => { if (alive) setFailed(true); });
    return () => { alive = false; ed.current?.destroy(); ed.current = null; };
  }, []);

  // закрытие — как открытие, только обратно: карточка опускается до высоты поля ввода, панель уезжает вниз,
  // текст гаснет; когда анимация кончилась — поле ввода на месте (сворачивание или отправка)
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const leave = (done: () => void) => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (reducedMotion()) { done(); return; }
    setClosing(true);
    onClosing?.();   // поле ввода начинает проявляться под опускающейся карточкой — подмена без провала
    setTimeout(done, CLOSE_MS);
  };
  const collapse = () => { const b = ed.current?.getBlocks() ?? blocks; leave(() => cbs.current.onCollapse(b)); };
  const send = () => { const b = ed.current?.getBlocks() ?? []; if (b.length) leave(() => cbs.current.onSend(b)); };
  const at = (e: MouseEvent, kind: 'insert' | 'lists') => setMenu({ kind, el: e.currentTarget as HTMLElement });
  const a = st.active;

  return (
    <div class={'app-art' + (closing ? ' app-art-closing' : '')} role="group" aria-label="Статья">
      <div class="app-art-top">
        <IconButton icon="undo" label="Отменить" disabled={!st.canUndo} onClick={() => ed.current?.undo()} />
        <IconButton icon="redo" label="Вернуть" disabled={!st.canRedo} onClick={() => ed.current?.redo()} />
        <span class="app-art-grow" />
        <IconButton icon="collapse" label="Свернуть редактор" onClick={collapse} />
      </div>
      <div class="app-art-scroll" onClick={(e) => { if (e.target === e.currentTarget) ed.current?.focus(); }}>
        {failed ? <div class="app-art-fail">Редактор не загрузился — проверьте сеть и попробуйте ещё раз.</div> : <div ref={host} class="app-art-host" />}
      </div>
      <div class="app-art-bar" role="toolbar" aria-label="Оформление статьи">
        <IconButton icon="plus" label="Вставить блок" onClick={(e: MouseEvent) => at(e, 'insert')} active={a.h1 || a.h2 || a.h3 || a.quote} />
        <IconButton icon="list" label="Списки" onClick={(e: MouseEvent) => at(e, 'lists')} active={a.ul || a.ol} />
        <IconButton icon="link" label="Ссылка" onClick={() => setLinkOpen(true)} active={a.link} />
        <IconButton icon="code" label="Блок кода" onClick={() => ed.current?.codeBlock()} active={a.code} />
        <span class="app-art-grow" />
        <button type="button" class="app-art-send" aria-label="Отправить (Ctrl+Enter)" disabled={st.empty} onClick={send}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l16-8-6 16-3-7z" /><path d="M11 13l9-9" /></svg>
        </button>
      </div>
            <MenuPopover open={!!menu} anchor={menu?.el} placement="top-start" label={menu?.kind === 'insert' ? 'Вставить блок' : 'Списки'} onClose={() => setMenu(null)}
              items={!menu ? [] : menu.kind === 'insert' ? [
                { icon: 'heading', label: 'Заголовок', submenu: [1, 2, 3].map((l) => ({ label: `Заголовок ${l}`, checked: !!a['h' + l], onClick: () => { ed.current?.heading(l as 1 | 2 | 3); setMenu(null); } })) },
                { icon: 'quote', label: 'Цитата', onClick: () => { ed.current?.quote(); setMenu(null); } },
                { icon: 'divider', label: 'Разделитель', onClick: () => { ed.current?.divider(); setMenu(null); } },
                { icon: 'text', label: 'Обычный текст', onClick: () => { ed.current?.paragraph(); setMenu(null); } },
              ] : [
                { icon: 'list', label: 'Маркированный список', onClick: () => { ed.current?.bulletList(); setMenu(null); } },
                { icon: 'listOrdered', label: 'Нумерованный список', onClick: () => { ed.current?.orderedList(); setMenu(null); } },
              ]} />
      <LinkDialog open={linkOpen} onClose={() => { setLinkOpen(false); ed.current?.focus(); }} onSave={(url, text) => { setLinkOpen(false); ed.current?.link(url, text); }} />
    </div>
  );
}

/** «Создать ссылку»: текст и адрес (как в Telegram); без выделения текст вставляется ссылкой. */
function LinkDialog({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (url: string, text: string) => void }) {
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  useEffect(() => { if (open) { setText(''); setUrl(''); } }, [open]);
  const norm = (u: string) => (/^[a-z][\w+.-]*:/i.test(u) ? u : 'https://' + u);
  const ok = !!url.trim();
  return (
    <Modal open={open} title="Создать ссылку" size="slim" onClose={onClose} actions={[
      <Button key="c" variant="ghost" onClick={onClose}>Отмена</Button>,
      <Button key="s" disabled={!ok} onClick={() => onSave(norm(url.trim()), text.trim() || url.trim())}>Создать</Button>,
    ]}>
      <div class="app-art-linkform">
        <TextField label="Текст" value={text} onInput={setText} autoFocus />
        <TextField label="Адрес" value={url} onInput={setUrl} inputMode="url" onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' && ok) onSave(norm(url.trim()), text.trim() || url.trim()); }} />
      </div>
    </Modal>
  );
}
