import { ChatRow, ChatRowSkeleton, EmptyState, Fab, IconButton, Presence, SearchInput, peerTone, requestMeasure, requestMutation, useMinVisible, WindowList } from '@relay/ui';
import type { ProfilePhoto } from '@relay/protocol';
import { rowAvatar } from '../../profilePhoto';
import type { Item } from '@relay/sync-engine/src/types';
import { useEffect, useRef, useState } from 'preact/hooks';
import { openChat, startDirectChat } from '../../data';
import { getGlobal, setGlobal, useGlobal } from '../../global';
import { back, home } from '../../nav';
import { showToast } from '../../settingsData';
import { lastSeenText } from '../format';
import { filterContacts, sectionsByLetter, sortByName, sortContacts, type ContactSort } from './contactsLogic';

const ROW = 72;          // высота ChatRow
const VIRTUAL_FROM = 50; // длинный список — виртуальный

/** Личный чат с человеком: уже есть — открыть, нет — создать (как «Новый чат»). Страница контактов уходит.
 *  Порядок важен: сначала назад к списку чатов (дождавшись истории), потом чат. Наоборот — открытый чат ложился
 *  слоем на запись «Контакты», и уход с неё по истории тут же закрывал его. */
export async function openDirect(userId: number): Promise<void> {
  if (getGlobal().sidebarView !== 'chats') await home();
  const chat = getGlobal().chats.find((c) => c.kind === 'direct' && c.peerId === userId);
  try {
    if (chat) openChat(chat.id as number);
    else await startDirectChat(userId);
  } catch {
    showToast('Не удалось открыть чат');
  }
}

function ContactRow({ c }: { c: Item }) {
  const online = !!c.online;
  const sub = c.known ? lastSeenText(online, c.lastSeen as string | null) : '';
  return (
    <ChatRow
      name={String(c.name)}
      avatarTone={peerTone(c.userId as number)}
      {...rowAvatar(c.photo as ProfilePhoto | null | undefined)}
      online={online}
      preview={<span class={online ? 'app-online' : undefined}>{sub}</span>}
      onClick={() => void openDirect(c.userId as number)}
    />
  );
}

const SORT_KEY = 'relay.contacts.sort';
const savedSort = (): ContactSort => { try { return localStorage.getItem(SORT_KEY) === 'seen' ? 'seen' : 'name'; } catch { return 'name'; } };

/** Буквы справа (как в Telegram): нажатие или ведение пальцем — к разделу. Прокрутка только своего контейнера. */
function LetterIndex({ letters, scroller }: { letters: string[]; scroller: { current: HTMLDivElement | null } }) {
  const last = useRef('');
  const jump = (x: number, y: number) => requestMeasure(() => {
    const btn = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-jump]');
    const letter = btn?.dataset.jump, el = scroller.current;
    if (!letter || !el || letter === last.current) return;
    last.current = letter;
    const sec = el.querySelector<HTMLElement>(`[data-letter="${CSS.escape(letter)}"]`);
    if (!sec) return;
    const top = sec.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    requestMutation(() => el.scrollTo({ top }));
  });
  return (
    <nav class="app-ct-index" aria-label="Алфавитный указатель"
      onPointerDown={(e) => { last.current = ''; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); jump(e.clientX, e.clientY); }}
      onPointerMove={(e) => { if (e.buttons) jump(e.clientX, e.clientY); }}>
      {letters.map((l) => <button key={l} type="button" data-jump={l} aria-label={'К букве ' + l}>{l}</button>)}
    </nav>
  );
}

/** «Контакты»: поиск по имени и @username, сортировка по имени (разделы по буквам) или по времени захода, FAB «Добавить контакт». */
export function Contacts() {
  const contacts = useGlobal((s) => s.contacts);
  const loaded = useGlobal((s) => s.contactsLoaded);
  const phase = useGlobal((s) => s.status.phase);
  const [q, setQ] = useState('');
  // поле поиска — в фокусе сразу (без прокрутки: страница ещё едет)
  useEffect(() => { (document.getElementById('contacts-search') as HTMLInputElement | null)?.focus({ preventScroll: true }); }, []);

  const waiting = !loaded && !contacts.length && phase !== 'offline';
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const [sort, setSort] = useState<ContactSort>(savedSort);
  const toggleSort = () => { const next = sort === 'name' ? 'seen' : 'name'; setSort(next); try { localStorage.setItem(SORT_KEY, next); } catch { /* ok */ } };
  const list = filterContacts(sort === 'name' ? sortByName(contacts) : sortContacts(contacts), q);
  const sections = sort === 'name' && !q.trim() ? sectionsByLetter(list) : null;
  const scroller = useRef<HTMLDivElement>(null);
  const row = (c: Item) => <ContactRow c={c} />;

  return (
    <div class="rl-sidepage" aria-label="Контакты">
      <div class="rl-panel-head app-contacts-head">
        <IconButton icon="arrowLeft" label="Назад" onClick={() => void back()} />
        <SearchInput id="contacts-search" label="Поиск контактов" placeholder="Поиск контактов" value={q} onInput={(e: Event) => setQ((e.target as HTMLInputElement).value)} />
        <IconButton icon={sort === 'name' ? 'sortSeen' : 'sortName'} label={sort === 'name' ? 'Сортировать по времени захода' : 'Сортировать по имени'} onClick={toggleSort} />
      </div>
      <div class="rl-page-scroll app-contacts" ref={scroller}>
        <div class="app-listwrap">
          <Presence show={skeleton} exitMs={280}>
            <div class="app-skel" aria-busy="true" aria-label="Загрузка контактов">
              {Array.from({ length: 8 }, (_, i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}
            </div>
          </Presence>
          {waiting || skeleton ? null : list.length && sections ? (
            <div role="list">
              {sections.map((s) => (
                <section key={s.letter} data-letter={s.letter} class="app-ct-sec">
                  <h4 class="app-ct-letter">{s.letter}</h4>
                  {s.items.map((c) => <div key={c.key} role="listitem">{row(c)}</div>)}
                </section>
              ))}
            </div>
          ) : list.length ? (
            list.length > VIRTUAL_FROM
              ? <WindowList role="list" items={list} rowHeight={ROW} getKey={(c: Item) => c.key} render={row} />
              : <div role="list">{list.map((c) => <div key={c.key} role="listitem">{row(c)}</div>)}</div>
          ) : q.trim() ? (
            <EmptyState kind="search" title="Ничего не найдено" text="Поиск идёт по именам и @именам пользователей." />
          ) : !loaded ? (
            <EmptyState kind="contacts" title="Нет сети" text="Контакты загрузятся, когда появится подключение." />
          ) : (
            <EmptyState kind="contacts" title="Пока нет контактов" text="Добавьте людей по @имени пользователя или номеру телефона." />
          )}
        </div>
      </div>
      {sections && sections.length > 1 && !waiting && !skeleton ? <LetterIndex letters={sections.map((s) => s.letter)} scroller={scroller} /> : null}
      <div class="rl-fab-slot"><Fab icon="userPlus" label="Добавить контакт" onClick={() => setGlobal({ newContact: {} })} /></div>
    </div>
  );
}
