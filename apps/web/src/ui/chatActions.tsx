// Действия с чатом, общие для меню «⋮» в шапке и ряда кнопок в «Информации»: окна «Отключить звук» (сроки),
// «Удалить чат» и «Покинуть группу/канал», а также вступление в канал или группу (подписка / заявка).
import { useState } from 'preact/hooks';
import type { GroupInfo, MyMembership } from '@relay/protocol';
import { ConfirmDialog, Modal, RadioRow } from '@relay/ui';
import { findChat, getGlobal, useGlobal } from '../global';
import { act, errorText } from '../groups';
import { MUTE_PRESETS, muteChat } from '../mute';
import { closeChat, groupCall, refreshPreview } from '../data';
import { showToast } from '../settingsData';

type Ask = null | 'mute' | 'delete' | 'leave';

/** Окна действий одного чата: open('mute' | 'delete' | 'leave') и узел с окнами, который надо отрисовать рядом. */
export function useChatDialogs(chatId: number, title: string): { open: (a: Exclude<Ask, null>) => void; node: preact.JSX.Element } {
  const chat = useGlobal((s) => findChat(s, chatId));
  const channel = chat?.kind === 'channel';
  const gMe = chat?.kind === 'group' || channel ? (chat!.me as MyMembership | null) ?? null : null;
  const owner = gMe?.role === 'owner';
  const what = channel ? 'канал' : 'группу';
  const [ask, setAsk] = useState<Ask>(null);
  const [preset, setPreset] = useState(MUTE_PRESETS.length - 1);

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

  const node = (
    <>
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
  return { open: (a) => { if (a === 'mute') setPreset(MUTE_PRESETS.length - 1); setAsk(a); }, node };
}

/**
 * Вступить: канал по @имени — /join/@имя (как «Подписаться» внизу ленты), группа — /groups/:id/join.
 * Вступление по одобрению — заявка (тост); вступил — строка чата придёт журналом, панели сменятся сами.
 * 'joined' | 'requested' | 'error' — чтобы кнопка знала, держать ли лоадер.
 */
export async function joinChat(chatId: number): Promise<'joined' | 'requested' | 'error'> {
  const chat = findChat(getGlobal(), chatId);
  const g = (chat?.group as GroupInfo | null) ?? null;
  const channel = chat?.kind === 'channel';
  if (channel && !g?.username) { showToast('Вступить можно по пригласительной ссылке канала'); return 'error'; }
  const r = await groupCall<{ chatId: number; requested: boolean }>('POST', channel ? '/join/@' + g!.username : `/groups/${chatId}/join`);
  if (!r.ok) { showToast(errorText(r.code)); return 'error'; }
  if (r.data.requested) {
    refreshPreview(chatId);   // строка превью — с заявкой: «Заявка отправлена» и при повторном открытии
    showToast('Заявка отправлена — администраторы её рассмотрят');
    return 'requested';
  }
  return 'joined';
}
