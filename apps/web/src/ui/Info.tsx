import type { ProfileLink } from '@relay/protocol';
import { ProfileLinks } from './links/ProfileLinks';
import { SharedMedia } from './SharedMedia';
import { membersStatus, useMembers } from '../members';
import { loadProfileMusic, playProfile, type ProfileTrack } from '../music';
import { Avatar, Icon, InfoRow, PanelHeader, RichText, SettingsIcon, SlideStack, Switch, Verified } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { chatTone, isSystemChat } from './format';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { syncMuted } from '../notify';
import { activeFrame, setGlobal, useGlobal } from '../global';

import { birthdayText, lastSeenText, type Birthday } from './format';
import { showToast, useUser } from '../settingsData';
import { EditContactPanel } from './contacts/EditContact';
import type { ProfilePhoto } from '@relay/protocol';
import { avatarPhoto } from '../profilePhoto';

const PAGES = ['info', 'edit'];   // «Изменить контакт» выезжает внутри панели справа налево
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
  const muted = useGlobal((s) => s.muted);
  const [page, setPage] = useState('info');
  useEffect(() => setPage('info'), [chatId]);   // другой чат — снова профиль
  // профиль собеседника личного чата: только то, что сервер разрешил показать
  // служебный чат «Relay»: без контакта, телефона и @имени — только уведомления
  const system = isSystemChat(chat);
  const peerId = chat?.kind === 'direct' && !system ? (chat.peerId as number | null) : null;
  const user = useUser(peerId);
  // контакт: ✎ в шапке ведёт в «Изменить»; не контакт — «Добавить в контакты»
  const contact = useGlobal((s) => (peerId ? s.contacts.find((c) => c.userId === peerId) ?? null : null));
  const contactsLoaded = useGlobal((s) => s.contactsLoaded);
  useEffect(() => {
    if (page !== 'info') return;   // на правке Esc — «Назад», его ловит форма
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [page]);

  const title = (chat?.title as string) || 'Чат №' + chatId;
  const group = chat?.kind === 'group';
  const members = useMembers(chatId, group);
  const myPeer = peer && chat?.peerId === peer.userId && peer.known ? peer : null;
  const subtitle = system ? 'служебные уведомления' : group ? (members ? membersStatus(members, false) : 'группа') : myPeer ? lastSeenText(!!myPeer.online, myPeer.lastSeen as string | null) : '';

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
      <PanelHeader icon="close" closeLabel="Закрыть" title={group ? 'Информация о группе' : 'Информация'} onClose={close} action={action} />
      <div class="rl-aside-body">
        <div class="rl-profile">
          <div class="app-prof-ava">
            <Avatar name={title} tone={chatTone(chat)} size={120} logo={system} {...avatarPhoto(chat?.photo as ProfilePhoto | null, true)} />
            {peerId ? <ProfileMusicPill userId={peerId} /> : null}
          </div>
          <div class="rl-profile-name">{title}{system ? <Verified size={22} /> : null}</div>
          <div class={'rl-profile-sub' + (myPeer?.online ? ' app-online' : '')}>{subtitle || ' '}</div>
          <Expand unclip show={!group && !!(user?.links as ProfileLink[] | undefined)?.length}>{!group && user ? <ProfileLinks links={(user.links as ProfileLink[] | undefined) ?? []} /> : null}</Expand>
        </div>
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
        <SharedMedia chatId={chatId} group={group} />
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
/** unclip — после раскрытия не обрезать содержимое (подсказки над кнопками). */
function Expand({ show, unclip, children }: { show: boolean; unclip?: boolean; children: ComponentChildren }) {
  const [state, setState] = useState<'instant' | 'closed' | 'open'>(show ? 'instant' : 'closed');
  useEffect(() => {
    if (!show) { setState('closed'); return; }
    if (state !== 'closed') return;
    const id = requestAnimationFrame(() => setState('open'));
    return () => cancelAnimationFrame(id);
  }, [show]);
  return <div class={'app-expand' + (unclip ? ' app-expand-unclip' : '')} data-state={show ? state : 'closed'}><div class="app-expand-inner">{children}</div></div>;
}

/** Музыка профиля — плашка поверх низа аватара (как в Telegram): «♪ трек ›», клик — играть и открыть плейлист. */
function ProfileMusicPill({ userId }: { userId: number }) {
  const [tracks, setTracks] = useState<ProfileTrack[]>([]);
  useEffect(() => {
    let live = true;
    setTracks([]);
    loadProfileMusic(userId).then((t) => { if (live) setTracks(t); }).catch(() => {});
    return () => { live = false; };
  }, [userId]);
  if (!tracks.length) return null;
  return (
    <button type="button" class="app-prof-music" onClick={() => playProfile(userId, tracks)}>
      <Icon name="music" size={14} /><span>{tracks[0].title}</span><Icon name="chevronRight" size={14} />
    </button>
  );
}
