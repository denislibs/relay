import type { ProfileLink, ProfileMusicSummary } from '@relay/protocol';
import { ProfileLinks } from './links/ProfileLinks';
import { SharedMedia } from './SharedMedia';
import { membersStatus, useMembers } from '../members';
import { openUserChat, startDirectChat } from '../data';
import { playProfileTop } from '../music';
import { Avatar, Icon, InfoRow, PanelHeader, RichText, SettingsIcon, SlideStack, Switch, Verified, onHeavyAnimationEnd, peerTone } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { chatTone, isSystemChat } from './format';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { activeFrame, setGlobal, useGlobal, getGlobal } from '../global';
import { isChatMuted, toggleMute } from '../mute';

import { birthdayText, lastSeenText, type Birthday } from './format';
import { showToast, useUser } from '../settingsData';
import { EditContactPanel } from './contacts/EditContact';
import type { ProfilePhoto } from '@relay/protocol';
import { avatarPhoto, useProfilePhotos, userPhoto } from '../profilePhoto';
import { ProfileGallery } from './ProfileGallery';
import { PhotoViewer } from './PhotoViewer';
import { StickersPanel } from './stickers/StickersPanel';
import { GROUP_PAGES, GroupScreen, isGroupPage, parentOf, type GroupPage, type Params } from './group/Manage';
import { canManage, copyText, publicUrl } from '../groups';
import type { GroupInfo, MyMembership } from '@relay/protocol';

const PAGES = ['info', 'stickers', 'edit', ...GROUP_PAGES];   // «Стикеры» — вторая вложенность (из поиска в панели стикеров)   // «Изменить контакт» и управление группой выезжают внутри панели справа налево
const close = () => setGlobal({ infoOpen: false });

/** Значение, которое меняется только вне тяжёлой анимации: во время неё — после её конца. */
function useSettled<T>(value: T): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return;
    let alive = true;
    onHeavyAnimationEnd(() => { if (alive) setSettled(value); });
    return () => { alive = false; };
  }, [value]);
  return settled;
}

/** Правая панель «Информация» о собеседнике или группе — как User Info в Telegram. */
export function Info() {
  // чат панели догоняет открытый после анимации перехода стека: её перерисовка (профиль, медиа, участники)
  // в первых кадрах перехода съедала бы их
  const chatId = useSettled(useGlobal((s) => s.openChatId))!;
  const chat = useGlobal((s) => s.chats.find((c) => c.id === chatId));
  const peer = useGlobal((s) => s.peer);
  const muted = useGlobal((s) => isChatMuted(chatId, s));
  // панель открывают сразу на «Стикерах» (поиск в панели стикеров): она выезжает уже на этой странице
  const [page, setPage] = useState(() => (getGlobal().infoGo === 'stickers' ? 'stickers' : 'info'));
  const [params, setParams] = useState<Params>({});
  const firstChat = useRef(true);
  useEffect(() => { if (firstChat.current) { firstChat.current = false; return; } setPage('info'); }, [chatId]);   // другой чат — снова профиль
  // управление группой: стек экранов, у каждого свой родитель; «Назад» — к родителю
  const nav = {
    chatId, params,
    go: (p: GroupPage, ps: Params = {}) => { setParams(ps); setPage(p); },
    back: () => setPage(isGroupPage(page) ? parentOf(page) : 'info'),
    close: () => { setPage('info'); close(); },
  };
  // переход снаружи (плашка заявок в шапке чата) — сразу на нужный экран
  const infoGo = useGlobal((s) => s.infoGo);
  // открыта ли была панель до перехода: закрытая выезжает сразу на нужной странице, без слайда внутри
  const infoOpen = useGlobal((s) => s.infoOpen);
  const openBefore = useRef(infoOpen), instant = useRef(false);
  useEffect(() => {
    if (!infoGo) return;
    if (infoGo === 'stickers') { setGlobal({ infoGo: null }); if (page !== 'stickers') { instant.current = !openBefore.current; setPage('stickers'); } return; }
    if (isGroupPage(infoGo)) { setGlobal({ infoGo: null }); nav.go(infoGo); }
    else if (infoGo === 'edit') { setGlobal({ infoGo: null }); setPage('edit'); }   // «Изменить» из меню шапки
  }, [infoGo]);
  // после перехода по infoGo (порядок важен: тот читает, была ли панель открыта до этого рендера)
  useEffect(() => { openBefore.current = infoOpen; if (!infoOpen && page === 'stickers') { instant.current = true; setPage('info'); } }, [infoOpen]);
  useEffect(() => { instant.current = false; }, [page]);
  // группа удалена или меня убрали — панель управления закрывается сама
  useEffect(() => { if (!chat && page !== 'info') setPage('info'); }, [!chat]);
  // профиль собеседника личного чата: только то, что сервер разрешил показать
  // служебный чат «Relay»: без контакта, телефона и @имени — только уведомления
  const system = isSystemChat(chat);
  const peerId = chat?.kind === 'direct' && !system ? (chat.peerId as number | null) : null;
  const user = useUser(peerId);
  // контакт: ✎ в шапке ведёт в «Изменить»; не контакт — «Добавить в контакты»
  const contact = useGlobal((s) => (peerId ? s.contacts.find((c) => c.userId === peerId) ?? null : null));
  const contactsLoaded = useGlobal((s) => s.contactsLoaded);
  useEffect(() => {
    if (isGroupPage(page)) {   // в управлении группой Esc — шаг назад
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.rl-mdl')) { e.preventDefault(); nav.back(); } };
      addEventListener('keydown', onKey);
      return () => removeEventListener('keydown', onKey);
    }
    if (page !== 'info') return;   // на правке Esc — «Назад», его ловит форма
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [page]);

  const title = (chat?.title as string) || 'Чат №' + chatId;
  const group = chat?.kind === 'group';
  const members = useMembers(chatId, group);
  const myPeer = peer && chat?.peerId === peer.userId && peer.known ? peer : null;
  const gallery = useProfilePhotos(group || system ? null : peerId, chat?.photo as ProfilePhoto | null);
  const [slide, setSlide] = useState(0);
  const [viewer, setViewer] = useState<number | null>(null);
  useEffect(() => { setSlide(0); setViewer(null); }, [chatId]);
  // как в Telegram: вкладки медиа доехали до верха и прилипли — шапка становится названием текущей вкладки
  // («Участники», «Медиа», «Файлы»…) со стрелкой наверх; смена вкладки — то же мягкое проявление заголовка
  const body = useRef<HTMLDivElement>(null);
  const [media, setMedia] = useState(false);
  const [mediaTitle, setMediaTitle] = useState('Общие медиа');
  const measuring = useRef(false);
  const onBodyScroll = () => {
    if (measuring.current) return;
    measuring.current = true;
    requestAnimationFrame(() => {
      measuring.current = false;
      const el = body.current, tabs = el?.querySelector('.rl-aside-tabs, .app-sm-heading');
      const stuck = !!el && !!tabs && el.scrollTop > 0 && tabs.getBoundingClientRect().top - el.getBoundingClientRect().top <= 1;
      setMedia((m) => (m === stuck ? m : stuck));
    });
  };
  const toTop = () => body.current?.scrollTo({ top: 0, behavior: 'smooth' });
  useEffect(() => { setMedia(false); }, [chatId]);
  const subtitle = system ? 'служебные уведомления' : group ? (members ? membersStatus(members, false) : 'группа') : myPeer ? lastSeenText(!!myPeer.online, myPeer.lastSeen as string | null) : '';

  const addContact = () => setGlobal({ newContact: {
    // запрос — то, что видно человеку: @имя или телефон; нет ни того, ни другого — поле пустое, добавим по id
    query: user?.username ? '@' + String(user.username) : user?.phone ? String(user.phone) : '', userId: peerId!,
    firstName: String(user?.firstName ?? title.split(' ')[0] ?? ''), lastName: String(user?.lastName ?? ''),
  } });
  // шапка справа: контакт — ✎ «Изменить», не контакт — «Добавить в контакты» (как в Telegram)
  const gInfo = (chat?.group as GroupInfo | null) ?? null, gMe = (chat?.me as MyMembership | null) ?? null;
  const action = group ? (canManage(gMe) ? { icon: 'pencil', label: 'Изменить группу', onClick: () => nav.go('gEdit') } : undefined)
    : !peerId || !contactsLoaded ? undefined
    : contact ? { icon: 'userPen', label: 'Изменить контакт', onClick: () => setPage('edit') }
    : { icon: 'contactAdd', label: 'Добавить в контакты', onClick: addContact };

  // участник из вкладки «Участники»: переписка с ним ложится в стек поверх группы (как в Telegram);
  // «Назад» в шапке возвращает в группу. Чата ещё нет — создаётся.
  const openMember = (userId: number) => { void openUserChat(userId); };

  return (
    <SlideStack order={PAGES} active={page} instant={instant.current} render={(k: string) => isGroupPage(k) ? (
      group && chat ? <GroupScreen page={k} nav={nav} /> : null
    ) : k === 'stickers' ? (
      <StickersPanel onBack={() => setPage('info')} />
    ) : k === 'edit' && peerId ? (
      <EditContactPanel userId={peerId} onDone={() => setPage('info')} />
    ) : (
    <div class="rl-sidepage">
      <PanelHeader class={media ? 'is-media' : undefined} icon={media ? 'arrowLeft' : 'close'} closeLabel={media ? 'Наверх' : 'Закрыть'}
        title={media ? mediaTitle : group ? 'Информация о группе' : 'Информация'} onClose={media ? toTop : close} action={media ? undefined : action} />
      <div class="rl-aside-body" ref={body} onScroll={onBodyScroll}>
        {gallery.length ? (
          <ProfileGallery photos={gallery} index={slide} onIndex={setSlide} onOpen={setViewer}
            name={<>{title}{system ? <Verified size={22} /> : null}</>}
            sub={<span class={myPeer?.online ? 'app-online' : ''}>{subtitle || ' '}</span>}
            extra={peerId ? <ProfileMusicPill userId={peerId} music={user?.music as ProfileMusicSummary | null | undefined} /> : null} />
        ) : (
        <div class="rl-profile">
          <div class="app-prof-ava">
            <Avatar name={title} tone={chatTone(chat)} size={120} logo={system} {...avatarPhoto(chat?.photo as ProfilePhoto | null, true)} />
            {peerId ? <ProfileMusicPill userId={peerId} music={user?.music as ProfileMusicSummary | null | undefined} /> : null}
          </div>
          <div class="rl-profile-name">{title}{system ? <Verified size={22} /> : null}</div>
          <div class={'rl-profile-sub' + (myPeer?.online ? ' app-online' : '')}>{subtitle || ' '}</div>
        </div>
        )}
        <div class="rl-aside-group">
          {/* как в Telegram: имя уже в шапке — строками только то, чего там нет, и только если поле заполнено */}
          <Expand show={!group && !!user}>{!group && user ? <PeerRows user={user} /> : null}</Expand>
          <Expand show={group && !!gInfo?.about}>{group && gInfo?.about ? (
            <div class="rl-inforow rl-inforow-static">
              <SettingsIcon icon="info" color="gray" />
              <span class="rl-inforow-text"><span class="rl-bio app-info-bio"><RichText text={gInfo.about} /></span><small>Описание</small></span>
            </div>
          ) : null}</Expand>
          <Expand show={group && !!gInfo?.username}>{group && gInfo?.username ? (
            <InfoRow tile="blue" icon="link" title={publicUrl(gInfo.username).replace(/^https?:\/\//, '')} subtitle="Ссылка" onClick={() => copyText(publicUrl(gInfo.username!))} />
          ) : null}</Expand>
          <Expand show={!group && !!(user?.links as ProfileLink[] | undefined)?.length}>{!group && user ? <ProfileLinks links={(user.links as ProfileLink[] | undefined) ?? []} /> : null}</Expand>
          <InfoRow
            tile="red"
            icon={muted ? 'bellOff' : 'bell'}
            title="Уведомления"
            trailing={<Switch id="info-notify" label="Уведомления" checked={!muted} onChange={() => toggleMute(chatId)} />}
          />
          <Expand show={!!contact?.note}>{contact?.note ? (
            <div class="rl-inforow rl-inforow-static">
              <SettingsIcon icon="pencil" color="gray" />
              <span class="rl-inforow-text"><span class="rl-bio app-info-bio"><RichText text={String(contact.note)} /></span><small>Заметки</small></span>
            </div>
          ) : null}</Expand>
        </div>
        <SharedMedia chatId={chatId} group={group} onTitle={setMediaTitle} onMember={openMember} />
        {viewer != null && gallery.length ? (
          <PhotoViewer photos={gallery} index={viewer} name={title} onIndex={setSlide} onClose={() => setViewer(null)}
            origin={(k) => (k === slide ? document.querySelector<HTMLElement>(`.app-gallery [data-gallery-slide="${k}"]`) : null)} />
        ) : null}
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

/** Музыка профиля — плашка поверх низа аватара (как в Telegram): «♪ трек ›», клик — играть и открыть плейлист.
 *  Сводка приходит в самом профиле (PublicUser.music) и обновляется по журналу (userUpdated) — без своего запроса. */
function ProfileMusicPill({ userId, music }: { userId: number; music: ProfileMusicSummary | null | undefined }) {
  if (!music?.top) return null;
  return (
    <button type="button" class="app-prof-music" onClick={() => playProfileTop(userId, music.top)}>
      <Icon name="music" size={14} /><span>{music.top.title}</span><Icon name="chevronRight" size={14} />
    </button>
  );
}

