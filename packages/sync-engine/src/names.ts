import type { ProfilePhoto } from '@relay/protocol';
import { contactName } from './contacts';
import type { Store } from './store';
import type { LocalChat } from './types';

/** Контакт зрителя с учётом ещё не подтверждённых операций (движок подставляет вид с очередью). */
function contactOf(store: Store, userId: number): { name: string; v: number; pending: boolean } | null {
  const c = store.contactOf(userId);
  if (!c) return null;
  return { name: contactName(c), v: store.contacts.table.get(userId)?.v ?? 0, pending: 'pending' in c && !!c.pending };
}

/** Как зритель видит человека: контактное имя, если есть контакт; иначе собственное имя профиля ('' — если ничего не знаем). */
export function displayName(store: Store, userId: number): string {
  const c = contactOf(store, userId);
  if (c?.name) return c.name;
  const u = store.users.get(userId);
  return u ? u.publicName ?? u.name : '';
}

/** Имя и фото для строки; sig меняется при правке профиля, контакта или неподтверждённой операции над контактом. */
export function personView(store: Store, userId: number): { name: string; photo: ProfilePhoto | null; sig: string } {
  const u = store.users.get(userId), c = contactOf(store, userId);
  const pend = c?.pending ? 'p' + c.name : '';
  return { name: displayName(store, userId), photo: u?.photo ?? null, sig: `${u?.v ?? 0}:${c?.v ?? 0}:${pend}` };
}

/** Название чата: группа — из group, личный — как зритель видит собеседника (null — ещё не знаем). */
export function chatTitle(store: Store, c: LocalChat): string | null {
  if (c.group) return c.group.title;
  return c.peerId != null ? displayName(store, c.peerId) || null : null;
}

/**
 * Строки личных чатов, чей собеседник выглядит иначе (профиль, контакт, операция в очереди или её отказ), —
 * пересчитать на проходе подписок: сам чат не менялся и в IndexedDB не пишется.
 */
export class PeerSigs {
  private shown = new Map<number, string>();

  retouch(store: Store): void {
    if (this.shown.size > store.chats.size * 2) this.shown.clear();   // удалённые чаты не копятся
    for (const c of store.chats.values()) {
      if (c.group || c.peerId == null) continue;
      const sig = c.peerId + ':' + personView(store, c.peerId).sig;
      if (this.shown.get(c.id) === sig) continue;
      this.shown.set(c.id, sig);
      store.retouch(c.id);
    }
  }
}
