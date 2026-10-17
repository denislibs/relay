// Контакты без DOM: сортировка, поиск, форма «Изменить».
import type { Item } from '@relay/sync-engine/src/types';
import { cleanName as clean, cleanText as cleanNote } from '@relay/sync-engine/src/text';
import { clip, cpLen, NAME_MAX } from '../settings/profileForm';

export const NOTE_MAX = 128;
export { clip, cpLen, NAME_MAX };

/** Сначала «в сети», потом по последнему визиту (свежие выше), потом по имени. */
export function sortContacts(list: Item[]): Item[] {
  // «недавно» (время скрыто) — выше «давно», но ниже любого точного времени
  const seen = (c: Item) => (c.lastSeen === 'recently' ? 1 : c.lastSeen ? Date.parse(c.lastSeen as string) || 0 : 0);
  return [...list].sort((a, b) =>
    Number(!!b.online) - Number(!!a.online) || seen(b) - seen(a) || String(a.name).localeCompare(String(b.name), 'ru'));
}

/** Локальный поиск: по контактному и собственному имени, по @username. */
export function filterContacts(list: Item[], q: string): Item[] {
  const s = q.trim().toLowerCase().replace(/^@/, '');
  if (!s) return list;
  return list.filter((c) => [c.name, c.publicName, c.username].some((v) => typeof v === 'string' && v.toLowerCase().includes(s)));
}

/** Инициалы для кружка «Новый контакт»: по букве от имени и фамилии. */
export function initialsOf(first: string, last: string): string {
  const a = [...first.trim()][0] ?? '', b = [...last.trim()][0] ?? '';
  return (a + b).toUpperCase();
}

export interface ContactForm { firstName: string; lastName: string; note: string }

export const formFromContact = (c: Item): ContactForm => ({ firstName: String(c.firstName ?? ''), lastName: String(c.lastName ?? ''), note: String(c.note ?? '') });

/** Что отправить: только изменившиеся поля. */
export function contactPatch(c: Item, f: ContactForm): Partial<ContactForm> {
  const p: Partial<ContactForm> = {};
  if (clean(f.firstName) !== clean(String(c.firstName ?? ''))) p.firstName = clean(f.firstName);
  if (clean(f.lastName) !== clean(String(c.lastName ?? ''))) p.lastName = clean(f.lastName);
  if (cleanNote(f.note) !== cleanNote(String(c.note ?? ''))) p.note = cleanNote(f.note);
  return p;
}
export const contactDirty = (c: Item, f: ContactForm) => Object.keys(contactPatch(c, f)).length > 0;
export const contactValid = (f: ContactForm) => !!clean(f.firstName) && cpLen(f.firstName) <= NAME_MAX && cpLen(f.lastName) <= NAME_MAX && cpLen(cleanNote(f.note)) <= NOTE_MAX;
