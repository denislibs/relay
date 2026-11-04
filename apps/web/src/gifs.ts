// Сохранённые GIF в интерфейсе: снимок из движка в памяти модуля (вкладка и меню сообщения читают его синхронно, без
// перерисовки чата), сохранение и отправка. Движок (savedGifs.ts) отвечает из кэша IndexedDB сразу, сервер — в фоне.
import type { Attachment, SavedGif } from '@relay/protocol';
import { useEffect, useState } from 'preact/hooks';
import { replyArgs } from './replyRef';
import { stickerTarget } from './stickers';
import { showToast } from './settingsData';

type Call = (a: Record<string, unknown> & { type: string }) => Promise<unknown>;
let call: Call = () => Promise.reject(new Error('engine is not ready'));
export function bindGifs(fn: Call): void { call = fn; }

export type GifAttachment = Attachment;
export interface GifSend { silent?: boolean; later?: boolean }
export interface GifsState { list: SavedGif[]; loaded: boolean }

let state: GifsState = { list: [], loaded: false };
let ids = new Set<string>();
let seenRev = -1;
const subs = new Set<() => void>();

function refresh(): void {
  call({ type: 'savedGifs' }).then((r) => {
    const next = r as GifsState;
    if (next.loaded === state.loaded && JSON.stringify(next.list) === JSON.stringify(state.list)) return;   // перерисовка 200 плиток — только если что-то изменилось
    state = next;
    ids = new Set(next.list.map((g) => g.id));
    subs.forEach((f) => f());
  }, () => {});
}
/** gifsRev из статуса движка (data.ts): журнал, подключение, свои правки. */
export function gifsRevChanged(rev: number): void {
  if (rev === seenRev) return;
  seenRev = rev;
  refresh();
}
export const isSavedGif = (id: string): boolean => ids.has(id);

export function useSavedGifs(): GifsState {
  const [s, set] = useState(state);
  useEffect(() => {
    const f = () => set(state);
    subs.add(f);
    f();
    if (seenRev < 0) refresh();
    return () => { subs.delete(f); };
  }, []);
  return s;
}

/** Из пузыря: снимок вложения — для мгновенной плитки, права проверит сервер по сообщению. */
export function saveGifFrom(chatId: number, messageId: number, att: GifAttachment): void {
  const { spoiler: _s, ...plain } = att;
  void call({ type: 'saveGif', chatId, messageId, gif: { ...plain, savedAt: Date.now() } });
  showToast('GIF сохранена');
}
export function removeSavedGif(id: string): void { void call({ type: 'removeGif', id }); }

/** Что можно в этом чате (как в кнопке отправки): без звука — не в «Избранном», позже — не в треде. */
export function gifSendOptions(): { silent: boolean; later: boolean; laterLabel: string } {
  const t = stickerTarget();
  return { silent: !t?.saved, later: !!t && (!!t.later || !!t.schedule), laterLabel: t?.saved ? 'Напомнить' : 'Отправить позже' };
}

/** Отправить в открытый чат с текущим ответом: обычная очередь, вложение то же — заново не загружается, черновик не трогается. */
export function sendGifHere(g: SavedGif, how: GifSend = {}): boolean {
  const t = stickerTarget();
  if (!t) return false;
  const { savedAt: _at, ...attachment } = g;
  const send = (w: { silent?: boolean; scheduleAt?: number }) => void call({ type: 'sendMessage', chatId: t.chatId, body: '', attachment, keepDraft: true, ...replyArgs(t.replyId()), ...(t.threadId != null ? { threadId: t.threadId } : {}), ...w });
  if (t.schedule) { t.schedule((w) => send(w)); t.sent(); return true; }   // страница отложенных: сначала время
  if (how.later && t.later) { t.later((r) => { send({ scheduleAt: r.at, silent: r.silent }); t.sent(); }); return true; }
  send(how.silent ? { silent: true } : {});
  t.sent();
  return true;
}
