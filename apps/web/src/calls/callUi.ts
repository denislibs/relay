import { getGlobal } from '../global';
import { startCall } from './callController';

/** Позвонить в личный чат (кнопка шапки, меню, «перезвонить» в ленте). */
export function callBack(chatId: number, video: boolean): void {
  const chat = getGlobal().chats.find((c) => c.id === chatId);
  const peerId = chat?.kind === 'direct' ? (chat.peerId as number | null) : null;
  if (peerId) void startCall(chatId, peerId, video);
}

/** Звонить можно в личный чат с человеком: не служебный, не «Избранное», не превью, без блокировки в любую сторону. */
export function canCall(chat: Record<string, unknown> | undefined | null, opts: { system: boolean; saved: boolean; blocked: boolean }): boolean {
  if (!chat || chat.kind !== 'direct' || chat.preview || opts.system || opts.saved || opts.blocked) return false;
  if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices) return false;   // браузер без WebRTC или не по https
  return typeof chat.peerId === 'number';
}
