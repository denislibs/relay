// Меню «⋮» в шапке чата — как в Telegram Web A: карточка у кнопки (растёт из правого верхнего угла),
// пункты по виду чата, разделитель и опасное действие последним, красным.
//  • личный: Изменить / Добавить в контакты, Отключить звук… / Включить звук, Выбрать сообщения,
//    Заблокировать / Разблокировать, — , Удалить чат (окно: для меня и собеседника / только для меня);
//  • группа: Изменить (админу), звук, Выбрать сообщения, — , Покинуть группу (владельцу — Удалить и покинуть);
//  • служебный «Relay»: только звук.
// «Отключить звук…» — окно со сроками (без подменю), «Включить звук» — сразу.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GroupInfo, MyMembership } from '@relay/protocol';
import { IconButton, MenuPopover, Modal, useHoverMenu } from '@relay/ui';
import { ThemeTiles } from './settings/ThemeTiles';
import { useBase } from '../wallpapers';
import { setChatTheme } from '../chatTheme';
import { getGlobal, setGlobal, useGlobal, findChat } from '../global';
import { blockUser, showToast, unblockUser, useUser } from '../settingsData';
import { canManage } from '../groups';
import { isSystemChat } from './format';
import { startSelect } from '../forward';
import { isMuted, unmuteChat } from '../mute';
import { openInner } from '../data';
import { useChatDialogs } from './chatActions';


export function ChatMenu({ chatId, title }: { chatId: number; title: string }) {
  const chat = useGlobal((s) => findChat(s, chatId));
  const muted = useGlobal((s) => isMuted(findChat(s, chatId)));
  const system = isSystemChat(chat);
  const peerId = chat?.kind === 'direct' && !system ? (chat.peerId as number | null) : null;
  const user = useUser(peerId);
  const contact = useGlobal((s) => (peerId ? s.contacts.some((c) => c.userId === peerId) : false));
  const contactsLoaded = useGlobal((s) => s.contactsLoaded);
  const iBlocked = useGlobal((s) => peerId != null && s.blocked.some((b) => b.userId === peerId));
  const channel = chat?.kind === 'channel';
  const gMe = chat?.kind === 'group' || channel ? (chat!.me as MyMembership | null) ?? null : null;
  const gInfo = chat?.kind === 'group' || channel ? (chat!.group as GroupInfo | null) ?? null : null;
  const owner = gMe?.role === 'owner';

  const [open, setOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const base = useBase();
  // тема чата: в личном — любой из двоих (не служебный, без блокировки), в группе и канале — кто меняет информацию
  const canTheme = !chat?.preview && ((peerId != null && !iBlocked && !user?.blocksMe) || (gMe != null && canManage(gMe)));
  const hover = useHoverMenu(open, setOpen);   // как в Telegram: наведение открывает, уход с кнопки и меню — закрывает
  const dialogs = useChatDialogs(chatId, title);
  const setAsk = (a: 'mute' | 'delete' | 'leave') => { setOpen(false); dialogs.open(a); };
  const btn = useRef<HTMLSpanElement>(null);
  useEffect(() => { setOpen(false); }, [chatId]);

  const addContact = () => setGlobal({ newContact: {
    query: user?.username ? '@' + String(user.username) : user?.phone ? String(user.phone) : '', userId: peerId!,
    firstName: String(user?.firstName ?? title.split(' ')[0] ?? ''), lastName: String(user?.lastName ?? ''),
  } });

  const items = [
    ...(peerId && contactsLoaded ? [contact
      ? { icon: 'pencil', label: 'Изменить', onClick: () => setGlobal({ infoOpen: true, infoGo: 'edit' }) }
      : { icon: 'userPlus', label: 'Добавить в контакты', onClick: addContact }] : []),
    ...(gMe && canManage(gMe) ? [{ icon: 'pencil', label: 'Изменить', onClick: () => setGlobal({ infoOpen: true, infoGo: 'gEdit' }) }] : []),
    // превью канала (не подписан): звук не настраивается — уведомлений и так нет
    ...(chat?.preview ? [] : [muted
      ? { icon: 'bell', label: 'Включить звук', onClick: () => unmuteChat(chatId) }
      : { icon: 'bellOff', label: 'Отключить звук…', onClick: () => setAsk('mute') }]),
    ...(!system && !gInfo?.protected ? [{ icon: 'checkCircle', label: 'Выбрать сообщения', onClick: () => startSelect(chatId, []) }] : []),
    ...(canTheme ? [{ icon: 'palette', label: 'Тема чата', onClick: () => { setOpen(false); setThemeOpen(true); } }] : []),
    ...(peerId ? [iBlocked
      ? { icon: 'block', label: 'Разблокировать', onClick: () => { void unblockUser(peerId).then(() => showToast('Пользователь разблокирован')); } }
      : { icon: 'block', label: 'Заблокировать', onClick: () => { void blockUser(peerId).then(() => showToast('Пользователь заблокирован')); } }] : []),
    ...(peerId ? ['-' as const, { icon: 'trash', label: 'Удалить чат', danger: true, onClick: () => setAsk('delete') }] : []),
    // канал с обсуждением — «Обсуждение»: группа комментариев поверх (если я в ней)
    ...(channel && gInfo?.linkedChatId != null && getGlobal().chats.some((c) => c.id === gInfo.linkedChatId) ? [{ icon: 'chats', label: 'Обсуждение', onClick: () => openInner(gInfo.linkedChatId!) }] : []),
    ...(gMe ? ['-' as const, { icon: owner ? 'trash' : 'logout', label: owner ? 'Удалить и покинуть' : channel ? 'Покинуть канал' : 'Покинуть группу', danger: true, onClick: () => setAsk('leave') }] : []),
  ];

  return (
    <>
      <span ref={btn} class="app-chatmenu-btn">
        <IconButton icon="more" label="Ещё" aria-haspopup="menu" aria-expanded={String(open)}
          onPointerEnter={hover.onPointerEnter} onPointerLeave={hover.onPointerLeave} onClick={hover.toggle} />
      </span>
      <MenuPopover open={open} hover anchor={btn.current?.firstElementChild ?? undefined} placement="bottom-end" label="Действия с чатом"
        items={items} onClose={() => setOpen(false)} onPointerEnter={hover.onPointerEnter} onPointerLeave={hover.onPointerLeave} />
      {dialogs.node}
      <Modal open={themeOpen} title="Тема чата" size="slim" onClose={() => setThemeOpen(false)}>
        <p class="rl-mdl-text app-chattheme-hint">{peerId ? 'Тему увидите вы оба.' : 'Тему увидят все участники.'} Светлая или тёмная — как у каждого в настройках.</p>
        <ThemeTiles base={base} selected={(chat?.theme as string | null) ?? null} onPick={(id) => { void setChatTheme(chatId, id); }} />
      </Modal>
    </>
  );
}
