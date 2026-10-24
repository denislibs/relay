// Меню «⋮» в шапке чата — как в Telegram Web A: карточка у кнопки (растёт из правого верхнего угла),
// пункты по виду чата, разделитель и опасное действие последним, красным.
//  • личный: Изменить / Добавить в контакты, Отключить звук… / Включить звук, Выбрать сообщения,
//    Заблокировать / Разблокировать, — , Удалить чат (окно: для меня и собеседника / только для меня);
//  • группа: Изменить (админу), звук, Выбрать сообщения, — , Покинуть группу (владельцу — Удалить и покинуть);
//  • служебный «Relay»: только звук.
// «Отключить звук…» — окно со сроками (без подменю), «Включить звук» — сразу.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GroupInfo, MyMembership } from '@relay/protocol';
import { ConfirmDialog, IconButton, MenuPopover, Modal, RadioRow, useHoverMenu } from '@relay/ui';
import { getGlobal, setGlobal, useGlobal, findChat } from '../global';
import { blockUser, showToast, unblockUser, useUser } from '../settingsData';
import { act, canManage } from '../groups';
import { isSystemChat } from './format';
import { startSelect } from '../forward';
import { isMuted, MUTE_PRESETS, muteChat, unmuteChat } from '../mute';
import { closeChat, openInner } from '../data';

type Ask = null | 'mute' | 'delete' | 'leave';

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
  const what = channel ? 'канал' : 'группу';
  const owner = gMe?.role === 'owner';

  const [open, setOpen] = useState(false);
  const hover = useHoverMenu(open, setOpen);   // как в Telegram: наведение открывает, уход с кнопки и меню — закрывает
  const [ask, setAsk] = useState<Ask>(null);
  const [preset, setPreset] = useState(MUTE_PRESETS.length - 1);
  const btn = useRef<HTMLSpanElement>(null);
  useEffect(() => { setOpen(false); setAsk(null); }, [chatId]);

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
      : { icon: 'bellOff', label: 'Отключить звук…', onClick: () => { setPreset(MUTE_PRESETS.length - 1); setAsk('mute'); } }]),
    ...(!system && !gInfo?.protected ? [{ icon: 'checkCircle', label: 'Выбрать сообщения', onClick: () => startSelect(chatId, []) }] : []),
    ...(peerId ? [iBlocked
      ? { icon: 'block', label: 'Разблокировать', onClick: () => { void unblockUser(peerId).then(() => showToast('Пользователь разблокирован')); } }
      : { icon: 'block', label: 'Заблокировать', onClick: () => { void blockUser(peerId).then(() => showToast('Пользователь заблокирован')); } }] : []),
    ...(peerId ? ['-' as const, { icon: 'trash', label: 'Удалить чат', danger: true, onClick: () => setAsk('delete') }] : []),
    // канал с обсуждением — «Обсуждение»: группа комментариев поверх (если я в ней)
    ...(channel && gInfo?.linkedChatId != null && getGlobal().chats.some((c) => c.id === gInfo.linkedChatId) ? [{ icon: 'chats', label: 'Обсуждение', onClick: () => openInner(gInfo.linkedChatId!) }] : []),
    ...(gMe ? ['-' as const, { icon: owner ? 'trash' : 'logout', label: owner ? 'Удалить и покинуть' : channel ? 'Покинуть канал' : 'Покинуть группу', danger: true, onClick: () => setAsk('leave') }] : []),
  ];

  const remove = async (forAll: boolean) => {
    setAsk(null);
    const ok = await act('POST', `/chats/${chatId}/delete`, { forAll });
    if (ok && getGlobal().openChatId === chatId) closeChat();
  };
  const leave = async () => {
    setAsk(null);
    const me = getGlobal().me?.userId;
    await act('DELETE', owner ? `/groups/${chatId}` : `/groups/${chatId}/members/${me}`);   // чат закроется сам, когда исчезнет из списка
  };

  return (
    <>
      <span ref={btn} class="app-chatmenu-btn">
        <IconButton icon="more" label="Ещё" aria-haspopup="menu" aria-expanded={String(open)}
          onPointerEnter={hover.onPointerEnter} onPointerLeave={hover.onPointerLeave} onClick={hover.toggle} />
      </span>
      <MenuPopover open={open} hover anchor={btn.current?.firstElementChild ?? undefined} placement="bottom-end" label="Действия с чатом"
        items={items} onClose={() => setOpen(false)} onPointerEnter={hover.onPointerEnter} onPointerLeave={hover.onPointerLeave} />
      <Modal open={ask === 'mute'} onClose={() => setAsk(null)} title="Отключить звук" size="confirm" closeButton={false}
        actions={[
          <button key="no" type="button" class="rl-mdl-btn" onClick={() => setAsk(null)}>Отмена</button>,
          <button key="ok" type="button" class="rl-mdl-btn" data-autofocus="" onClick={() => { muteChat(chatId, MUTE_PRESETS[preset].seconds); setAsk(null); }}>Готово</button>,
        ]}>
        <div role="radiogroup" aria-label="Срок" class="app-mute-list">
          {MUTE_PRESETS.map((p, i) => <RadioRow key={p.label} label={p.label} checked={i === preset} onClick={() => setPreset(i)} />)}
        </div>
      </Modal>
      <Modal open={ask === 'delete'} onClose={() => setAsk(null)} title="Удалить чат" size="confirm" role="alertdialog" closeButton={false}>
        <p class="rl-mdl-text">Удалить чат с <b>{title}</b>? Это действие нельзя отменить.</p>
        <div class="app-delchat-actions">
          <button type="button" class="rl-mdl-btn rl-mdl-btn-danger" onClick={() => void remove(true)}>Удалить для меня и {title}</button>
          <button type="button" class="rl-mdl-btn rl-mdl-btn-danger" onClick={() => void remove(false)}>Удалить только для меня</button>
          <button type="button" class="rl-mdl-btn" data-autofocus="" onClick={() => setAsk(null)}>Отмена</button>
        </div>
      </Modal>
      <ConfirmDialog open={ask === 'leave'} danger title={owner ? `Удалить ${what}` : `Покинуть ${what}`}
        text={owner ? `Удалить ${what} «${title}» для всех ${channel ? 'подписчиков' : 'участников'}? Это действие нельзя отменить.` : `Покинуть ${what} «${title}»?`}
        confirm={owner ? 'Удалить' : 'Покинуть'} onConfirm={() => void leave()} onCancel={() => setAsk(null)} />
    </>
  );
}
