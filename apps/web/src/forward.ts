// Пересылка сообщений, как в Telegram Web: «Переслать» → окно выбора чатов. Один чат — открываем его, пересылка
// ждёт в поле ввода (можно дописать комментарий, скрыть отправителя или подписи); несколько — уходит сразу во все.
import type { Entity } from '@relay/protocol';
import { forwardMessages, openInner, sentSound } from './data';
import { getGlobal, setGlobal, type ForwardDraft, type ForwardPick } from './global';
import { showToast } from './settingsData';
import { plural } from '@relay/ui';

type Src = Record<string, unknown>;
const KIND: Record<string, string> = { photo: 'Фото', file: 'Файл', voice: 'Голосовое сообщение', round: 'Видеосообщение', audio: 'Музыка' };

/** Открыть окно «Переслать в…» для сообщений чата fromChatId (по порядку в ленте); nameOf — имя автора для панели. */
export function startForward(fromChatId: number, items: Src[], nameOf: (userId: number) => string): void {
  startForwardMany([{ chatId: fromChatId, items }], nameOf);
}

/** То же для сообщений из нескольких чатов (выбор в глобальном поиске): пересылаются по чатам, в порядке групп. */
export function startForwardMany(groups: { chatId: number; items: Src[] }[], nameOf: (userId: number) => string): void {
  const parts = groups.map((g) => ({ chatId: g.chatId, list: g.items.filter((m) => m.id != null && !m.deleted && !m.service).sort((a, b) => (a.id as number) - (b.id as number)) }))
    .filter((g) => g.list.length);
  if (!parts.length) return;
  const list = parts.flatMap((g) => g.list);
  const senders: { id: number; name: string }[] = [];
  for (const m of list) {
    // у пересланного — исходный автор, как и покажет получатель
    const f = m.fwdFrom as { userId: number; name: string } | null | undefined;
    const id = f ? f.userId : m.senderId as number;
    if (!senders.some((s) => s.id === id)) senders.push({ id, name: f ? f.name : nameOf(id) });
  }
  const first = list[0];
  const att = first.attachment as { kind?: string; name?: string } | null | undefined;
  const text = (first.body as string) || (att ? (att.kind === 'file' && att.name ? att.name : KIND[att.kind ?? ''] ?? 'Вложение') : '');
  const captions = list.some((m) => !!m.attachment && !!m.body);
  const [head, ...rest] = parts;
  setGlobal({ fwdPick: { fromChatId: head.chatId, ids: head.list.map((m) => m.id as number), ...(rest.length ? { more: rest.map((g) => ({ fromChatId: g.chatId, ids: g.list.map((m) => m.id as number) })) } : {}),
    preview: { senders, text, count: list.length, captions } } });
}

export function closeForwardPick(): void { setGlobal({ fwdPick: null }); }

/** Выбор в окне: один чат — панель пересылки в его поле ввода; несколько — сразу во все, с подписью первой. */
export async function forwardTo(chatIds: number[], comment: string): Promise<void> {
  const pick = getGlobal().fwdPick;
  if (!pick || !chatIds.length) return;
  setGlobal({ fwdPick: null });
  if (chatIds.length === 1) {
    const chatId = chatIds[0];
    setGlobal({ fwdDraft: { ...getGlobal().fwdDraft, [chatId]: { ...pick, hideSender: false, hideCaption: false } } });
    openInner(chatId);   // переслать из чата — получатель поверх, «Назад» возвращает (docs/navigation-rules.md)
    return;
  }
  sentSound();
  await forwardParts(pick, { toChatIds: chatIds, comment: comment.trim() ? { body: comment } : null });
  const n = chatIds.length, chats = `${n} ${plural(n, 'чат', 'чата', 'чатов')}`;
  showToast(pick.ids.length > 1 ? `Сообщения пересланы в ${chats}` : `Сообщение переслано в ${chats}`);
}

/** Пересылка, ждущая в поле ввода этого чата. */
export function forwardDraft(chatId: number): ForwardDraft | null { return getGlobal().fwdDraft[chatId] ?? null; }

export function patchForwardDraft(chatId: number, patch: Partial<ForwardDraft>): void {
  const cur = getGlobal().fwdDraft[chatId];
  if (cur) setGlobal({ fwdDraft: { ...getGlobal().fwdDraft, [chatId]: { ...cur, ...patch } } });
}

export function cancelForwardDraft(chatId: number): void {
  const next = { ...getGlobal().fwdDraft };
  delete next[chatId];
  setGlobal({ fwdDraft: next });
}

/** «Другой чат…»: снова окно выбора с теми же сообщениями. */
export function forwardElsewhere(chatId: number): void {
  const d = getGlobal().fwdDraft[chatId];
  if (!d) return;
  cancelForwardDraft(chatId);
  setGlobal({ fwdPick: { fromChatId: d.fromChatId, ids: d.ids, ...(d.more ? { more: d.more } : {}), preview: d.preview } });
}

/** Отправка из поля ввода: комментарий (если есть) первым, затем пересланное. */
export async function sendForwardDraft(chatId: number, body: string, entities: Entity[] = []): Promise<void> {
  const d = getGlobal().fwdDraft[chatId];
  if (!d) return;
  cancelForwardDraft(chatId);
  sentSound();
  await forwardParts(d, { toChatIds: [chatId], hideSender: d.hideSender, hideCaption: d.hideCaption, comment: body.trim() ? { body, entities } : null });
}

type ForwardOpts = Omit<Parameters<typeof forwardMessages>[0], 'fromChatId' | 'ids'>;
/** Пересылка по чатам-источникам: комментарий — только с первой частью (он уходит первым, перед пересланным). */
async function forwardParts(p: ForwardPick, o: ForwardOpts): Promise<void> {
  const parts = [{ fromChatId: p.fromChatId, ids: p.ids }, ...(p.more ?? [])];
  for (let i = 0; i < parts.length; i++) await forwardMessages({ ...o, ...parts[i], comment: i ? null : o.comment });
}

/** Режим выбора: начать с сообщения (у альбома — все его ключи), отметить/снять, выйти. */
export function startSelect(chatId: number, keys: string[]): void { setGlobal({ selecting: { chatId, keys: [...new Set(keys)] } }); }
export function toggleSelect(chatId: number, keys: string[]): void {
  const cur = getGlobal().selecting;
  if (!cur || cur.chatId !== chatId) return;
  const on = keys.every((k) => cur.keys.includes(k));
  const next = on ? cur.keys.filter((k) => !keys.includes(k)) : [...cur.keys, ...keys.filter((k) => !cur.keys.includes(k))];
  setGlobal({ selecting: next.length ? { chatId, keys: next } : null });   // сняли последнее — режим выбора закрывается, как в Telegram
}
export function endSelect(): void { if (getGlobal().selecting) setGlobal({ selecting: null }); }
