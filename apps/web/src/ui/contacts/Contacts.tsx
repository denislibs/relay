import { ChatRow, ChatRowSkeleton, EmptyState, Fab, IconButton, Presence, SearchField, useMinVisible, WindowList } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { useEffect, useState } from 'preact/hooks';
import { openChat, startDirectChat } from '../../data';
import { getGlobal, setGlobal, useGlobal } from '../../global';
import { back } from '../../nav';
import { showToast } from '../../settingsData';
import { lastSeenText } from '../format';
import { filterContacts, sortContacts } from './contactsLogic';

const ROW = 72;          // высота ChatRow
const VIRTUAL_FROM = 50; // длинный список — виртуальный

/** Личный чат с человеком: уже есть — открыть, нет — создать (как «Новый чат»). Страница контактов уходит. */
export async function openDirect(userId: number): Promise<void> {
  const chat = getGlobal().chats.find((c) => c.kind === 'direct' && c.peerId === userId);
  try {
    if (chat) openChat(chat.id as number);
    else await startDirectChat(userId);
  } catch {
    showToast('Не удалось открыть чат');
    return;
  }
  if (getGlobal().sidebarView !== 'chats') void back();
}

function ContactRow({ c }: { c: Item }) {
  const online = !!c.online;
  const sub = c.known ? lastSeenText(online, c.lastSeen as string | null) : '';
  return (
    <ChatRow
      name={String(c.name)}
      online={online}
      preview={<span class={online ? 'app-online' : undefined}>{sub}</span>}
      onClick={() => void openDirect(c.userId as number)}
    />
  );
}

/** «Контакты»: поиск по имени и @username, «в сети» сверху, FAB «Добавить контакт». */
export function Contacts() {
  const contacts = useGlobal((s) => s.contacts);
  const loaded = useGlobal((s) => s.contactsLoaded);
  const phase = useGlobal((s) => s.status.phase);
  const [q, setQ] = useState('');
  // поле поиска — в фокусе сразу (без прокрутки: страница ещё едет)
  useEffect(() => { (document.getElementById('contacts-search') as HTMLInputElement | null)?.focus({ preventScroll: true }); }, []);

  const waiting = !loaded && !contacts.length && phase !== 'offline';
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const list = filterContacts(sortContacts(contacts), q);
  const row = (c: Item) => <ContactRow c={c} />;

  return (
    <div class="rl-sidepage" aria-label="Контакты">
      <div class="rl-panel-head app-contacts-head">
        <IconButton icon="arrowLeft" label="Назад" onClick={() => void back()} />
        <SearchField id="contacts-search" label="Поиск контактов" placeholder="Поиск контактов" value={q} onInput={(e: Event) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <div class="rl-page-scroll app-contacts">
        <div class="app-listwrap">
          <Presence show={skeleton} exitMs={280}>
            <div class="app-skel" aria-busy="true" aria-label="Загрузка контактов">
              {Array.from({ length: 8 }, (_, i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}
            </div>
          </Presence>
          {waiting || skeleton ? null : list.length ? (
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
      <div class="rl-fab-slot"><Fab icon="userPlus" label="Добавить контакт" onClick={() => setGlobal({ newContact: {} })} /></div>
    </div>
  );
}
