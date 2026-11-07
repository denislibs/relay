import type { CallInfo } from '@relay/protocol';

/**
 * Системное уведомление о входящем звонке со страницы (вкладка скрыта) — то же, что показывает service worker по
 * пушу, когда вкладок нет (sw.ts): тег call-<id>, «Принять / Отклонить». Клик приходит в sw.ts → сообщение
 * { type: 'call' } странице или новая вкладка с #call=<id>[&accept=1].
 */

export type CallIntent = { callId: string; accept: boolean };

/** #call=<uuid>[&accept=1] — вкладка открыта из уведомления о звонке. */
export function parseCallHash(hash: string): CallIntent | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const id = p.get('call');
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return { callId: id, accept: p.get('accept') === '1' };
}

export const callTag = (callId: string) => 'call-' + callId;

export function showCallNotification(c: CallInfo, title: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !navigator.serviceWorker) return;
  void navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, {
    body: c.video ? 'Входящий видеозвонок' : 'Входящий звонок',
    tag: callTag(c.callId), requireInteraction: true, silent: true,   // мелодию играет вкладка
    data: { chatId: c.chatId, callId: c.callId },
    actions: [{ action: 'accept', title: 'Принять' }, { action: 'decline', title: 'Отклонить' }],
  } as NotificationOptions)).catch(() => {});
}

export function closeCallNotification(callId: string): void {
  if (!navigator.serviceWorker) return;
  void navigator.serviceWorker.ready.then((reg) => reg.getNotifications({ tag: callTag(callId) })).then((list) => list.forEach((n) => n.close())).catch(() => {});
}
