import type { ProfileLink } from '@relay/protocol';
import { ProfileLinks } from './links/ProfileLinks';
import { Avatar, EmptyState, FolderTabs, InfoRow, LazyImage, PanelHeader, RichText, SettingsIcon, SlideStack, Switch } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { chatMedia, focusMessage } from '../data';
import { chatTone, fileSize } from './format';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { syncMuted } from '../notify';
import { activeFrame, setGlobal, useGlobal } from '../global';

const NO_MESSAGES: Item[] = [];
import { birthdayText, clock, dayLabel, lastSeenText, type Birthday } from './format';
import { showToast, useUser } from '../settingsData';
import { EditContactPanel } from './contacts/EditContact';

const TABS = ['media', 'files', 'links'];
const PAGES = ['info', 'edit'];   // «Изменить контакт» выезжает внутри панели справа налево
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const close = () => setGlobal({ infoOpen: false });

// уведомления выключаются только на этом устройстве (как «Без звука» локально): список chatId в localStorage
const MUTED_KEY = 'relay.muted';
export function loadMuted(): number[] { try { return JSON.parse(localStorage.getItem(MUTED_KEY) ?? '[]'); } catch { return []; } }
export function toggleMuted(chatId: number, muted: number[]): void {
  const next = muted.includes(chatId) ? muted.filter((x) => x !== chatId) : [...muted, chatId];
  try { localStorage.setItem(MUTED_KEY, JSON.stringify(next)); } catch { /* приватный режим */ }
  setGlobal({ muted: next });
  syncMuted();
}

/** Правая панель «Информация» о собеседнике или группе — как User Info в Telegram. */
export function Info() {
  const chatId = useGlobal((s) => s.openChatId)!;
  const chat = useGlobal((s) => s.chats.find((c) => c.id === s.openChatId));
  const peer = useGlobal((s) => s.peer);
  const messages = useGlobal((s) => activeFrame(s)?.messages ?? NO_MESSAGES);
  const muted = useGlobal((s) => s.muted);
  const [tab, setTab] = useState('media');
  const [page, setPage] = useState('info');
  useEffect(() => setPage('info'), [chatId]);   // другой чат — снова профиль
  // профиль собеседника личного чата: только то, что сервер разрешил показать
  const peerId = chat?.kind === 'direct' ? (chat.peerId as number | null) : null;
  const user = useUser(peerId);
  // контакт: ✎ в шапке ведёт в «Изменить»; не контакт — «Добавить в контакты»
  const contact = useGlobal((s) => (peerId ? s.contacts.find((c) => c.userId === peerId) ?? null : null));
  const contactsLoaded = useGlobal((s) => s.contactsLoaded);
  // медиа и файлы чата — с сервера (вся история), при открытии вкладки
  const [media, setMedia] = useState<{ photo?: Item[]; file?: Item[] }>({});
  useEffect(() => {
    if (tab === 'links') return;
    const kind = tab === 'media' ? 'photo' : 'file';
    let live = true;
    chatMedia(chatId, kind).then((list) => { if (live) setMedia((m) => ({ ...m, [kind]: list })); }).catch(() => {});
    return () => { live = false; };
  }, [tab, chatId]);

  useEffect(() => {
    if (page !== 'info') return;   // на правке Esc — «Назад», его ловит форма
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [page]);

  const title = (chat?.title as string) || 'Чат №' + chatId;
  const group = chat?.kind === 'group';
  const myPeer = peer && chat?.peerId === peer.userId && peer.known ? peer : null;
  const subtitle = group ? 'группа' : myPeer ? lastSeenText(!!myPeer.online, myPeer.lastSeen as string | null) : '';
  const links = messages
    .flatMap((m) => ((m.body as string).match(URL_RE) ?? []).map((url) => ({ url, at: m.createdAt as string, key: m.key + url })))
    .reverse();

  const addContact = () => setGlobal({ newContact: {
    // запрос — то, что видно человеку: @имя или телефон; нет ни того, ни другого — поле пустое, добавим по id
    query: user?.username ? '@' + String(user.username) : user?.phone ? String(user.phone) : '', userId: peerId!,
    firstName: String(user?.firstName ?? title.split(' ')[0] ?? ''), lastName: String(user?.lastName ?? ''),
  } });
  // шапка справа: контакт — ✎ «Изменить», не контакт — «Добавить в контакты» (как в Telegram)
  const action = !peerId || !contactsLoaded ? undefined
    : contact ? { icon: 'pencil', label: 'Изменить контакт', onClick: () => setPage('edit') }
    : { icon: 'userPlus', label: 'Добавить в контакты', onClick: addContact };

  return (
    <SlideStack order={PAGES} active={page} render={(k: string) => k === 'edit' && peerId ? (
      <EditContactPanel userId={peerId} onDone={() => setPage('info')} />
    ) : (
    <div class="rl-sidepage">
      <PanelHeader icon="close" closeLabel="Закрыть" title="Информация" onClose={close} action={action} />
      <div class="rl-aside-body">
        <div class="rl-profile">
          <Avatar name={title} tone={chatTone(chat)} size={120} />
          <div class="rl-profile-name">{title}</div>
          <div class={'rl-profile-sub' + (myPeer?.online ? ' app-online' : '')}>{subtitle || ' '}</div>
        </div>
        <Expand show={!group && !!(user?.links as ProfileLink[] | undefined)?.length}>{!group && user ? <ProfileLinks links={(user.links as ProfileLink[] | undefined) ?? []} /> : null}</Expand>
        <div class="rl-aside-group">
          {/* как в Telegram: имя уже в шапке — строками только то, чего там нет, и только если поле заполнено */}
          <Expand show={!group && !!user}>{!group && user ? <PeerRows user={user} /> : null}</Expand>
          <InfoRow
            tile="red"
            icon={muted.includes(chatId) ? 'bellOff' : 'bell'}
            title="Уведомления"
            subtitle={muted.includes(chatId) ? 'Выключены на этом устройстве' : 'Включены'}
            trailing={<Switch id="info-notify" label="Уведомления" checked={!muted.includes(chatId)} onChange={() => toggleMuted(chatId, muted)} />}
          />
          <Expand show={!!contact?.note}>{contact?.note ? (
            <div class="rl-inforow rl-inforow-static">
              <SettingsIcon icon="pencil" color="gray" />
              <span class="rl-inforow-text"><span class="rl-bio app-info-bio"><RichText text={String(contact.note)} /></span><small>Заметки</small></span>
            </div>
          ) : null}</Expand>
        </div>
        <div class="rl-aside-tabs">
          <FolderTabs label="Вложения чата" active={tab} onChange={setTab} items={[
            { id: 'media', label: 'Медиа' },
            { id: 'files', label: 'Файлы' },
            { id: 'links', label: 'Ссылки', count: links.length || undefined },
          ]} />
        </div>
        <div class="rl-aside-pages">
          <SlideStack variant="tabs" order={TABS} active={tab} render={(k: string) =>
            k === 'media' && media.photo?.length ? (
              <div class="app-media-grid">
                {media.photo.map((m) => { const a = m.attachment as { id: string; thumb?: string; name: string }; return (
                  <button key={m.key} type="button" class="app-media-cell" aria-label={a.name} onClick={() => focusMessage({ id: m.id as number, sort: m.id as number })}>
                    <LazyImage src={`/files/${a.id}`} thumb={a.thumb} alt={a.name} />
                  </button>
                ); })}
              </div>
            ) : k === 'files' && media.file?.length ? (
              <ul class="rl-aside-links">
                {media.file.map((m) => { const a = m.attachment as { id: string; name: string; size: number }; return (
                  <li key={m.key}><a href={`/files/${a.id}?download=1`} download={a.name}><b>{a.name}</b><small>{fileSize(a.size)} · {dayLabel(m.createdAt as string)}</small></a></li>
                ); })}
              </ul>
            ) : k === 'links' && links.length ? (
              <ul class="rl-aside-links">
                {links.map((l) => (
                  <li key={l.key}><a href={l.url} target="_blank" rel="noopener noreferrer"><b>{l.url}</b><small>{dayLabel(l.at)}, {clock(l.at)}</small></a></li>
                ))}
              </ul>
            ) : (
              <EmptyState
                kind={k}
                title={k === 'media' ? 'Здесь пока пусто' : k === 'files' ? 'Файлов пока нет' : 'Ссылок пока нет'}
                text={k === 'media' ? 'Фото и видео из этого чата появятся здесь.' : k === 'files' ? 'Документы и архивы из переписки соберутся здесь.' : 'Ссылки из сообщений этого чата появятся здесь.'}
              />
            )
          } />
        </div>
      </div>
    </div>
    )} />
  );
}

const copy = (text: string) => { navigator.clipboard?.writeText(text).then(() => showToast('Скопировано')).catch(() => { /* буфер недоступен */ }); };

/** @username, «Телефон», «О себе», «День рождения» — каждая строка, только если поле видно. */
function PeerRows({ user }: { user: Item }) {
  const username = user.username ? '@' + String(user.username) : null;
  const bio = (user.bio as string | null)?.trim() || null;
  const birthday = user.birthday ? birthdayText(user.birthday as Birthday) : null;
  const phone = user.phone ? String(user.phone) : null;
  return (
    <>
      {username ? <InfoRow tile="blue" icon="at" title={username} subtitle="Имя пользователя" onClick={() => copy(username)} /> : null}
      {phone ? <InfoRow tile="green" icon="phone" title={phone} subtitle="Телефон" onClick={() => copy(phone)} /> : null}
      {bio ? (
        <div class="rl-inforow rl-inforow-static">
          <SettingsIcon icon="info" color="gray" />
          <span class="rl-inforow-text"><span class="rl-bio app-info-bio"><RichText text={bio} /></span><small>О себе</small></span>
        </div>
      ) : null}
      {birthday ? <InfoRow tile="purple" icon="cake" title={birthday} subtitle="День рождения" /> : null}
    </>
  );
}

/**
 * Строки, пришедшие позже панели, раскрываются по высоте, а не толкают вкладки рывком.
 * Были с самого начала (кэш) — показываем сразу, без анимации.
 */
function Expand({ show, children }: { show: boolean; children: ComponentChildren }) {
  const [state, setState] = useState<'instant' | 'closed' | 'open'>(show ? 'instant' : 'closed');
  useEffect(() => {
    if (!show) { setState('closed'); return; }
    if (state !== 'closed') return;
    const id = requestAnimationFrame(() => setState('open'));
    return () => cancelAnimationFrame(id);
  }, [show]);
  return <div class="app-expand" data-state={show ? state : 'closed'}><div class="app-expand-inner">{children}</div></div>;
}
