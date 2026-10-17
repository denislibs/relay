import type { PresenceItem } from '@relay/protocol';
import { sql } from '../db';

/**
 * Кто в сети: число открытых WebSocket пользователя в этом процессе.
 * «Не в сети» объявляем не сразу, а через GRACE_MS: перезагрузка вкладки или короткий обрыв не мигают
 * у собеседников. Изменения рассылаются собеседникам по личным чатам сразу, мимо журнала — это не данные,
 * а состояние момента. (Один процесс сервера; для нескольких понадобится общий реестр, например через NOTIFY.)
 */
const conns = new Map<number, number>();
const leaving = new Map<number, ReturnType<typeof setTimeout>>();
const graceMs = () => Number(process.env.RELAY_PRESENCE_GRACE_MS ?? 4000);
/** Публикация в топик пользователя на том сервере, где живёт соединение. */
export type Publish = (topic: string, msg: string) => void;

export function isOnline(userId: number): boolean {
  return (conns.get(userId) ?? 0) > 0 || leaving.has(userId);
}

/** Кому сообщать о присутствии пользователя: собеседникам по личным чатам и тем, у кого он в контактах. */
async function peersOf(userId: number): Promise<number[]> {
  const rows = await sql`
    select o.user_id from chat_members m
    join chats c on c.id = m.chat_id and c.kind = 'direct'
    join chat_members o on o.chat_id = m.chat_id and o.user_id <> m.user_id
    where m.user_id = ${userId}
    union
    select owner_id from contacts where user_id = ${userId}`;
  return rows.map((r) => Number(r.user_id));
}

async function announce(publish: Publish, item: PresenceItem): Promise<void> {
  const msg = JSON.stringify({ op: 'presence', items: [item] });
  for (const peer of await peersOf(item.userId)) publish(`user:${peer}`, msg);
}

export async function connected(publish: Publish, userId: number): Promise<void> {
  const n = (conns.get(userId) ?? 0) + 1;
  conns.set(userId, n);
  const pending = leaving.get(userId);
  if (pending) { clearTimeout(pending); leaving.delete(userId); return; } // вернулся до конца паузы — для собеседников он и не уходил
  if (n === 1) await announce(publish, { userId, online: true, lastSeen: null });
}

export function disconnected(publish: Publish, userId: number): void {
  const n = Math.max(0, (conns.get(userId) ?? 0) - 1);
  if (n > 0) { conns.set(userId, n); return; }
  conns.delete(userId);
  leaving.set(userId, setTimeout(async () => {
    leaving.delete(userId);
    if ((conns.get(userId) ?? 0) > 0) return;
    const [row] = await sql`update users set last_seen_at = now() where id = ${userId} returning last_seen_at`;
    await announce(publish, { userId, online: false, lastSeen: row ? new Date(row.last_seen_at as string).toISOString() : null });
  }, graceMs()));
}

/** Присутствие всех собеседников и контактов пользователя — снимок после подключения. */
export async function listPresence(userId: number): Promise<PresenceItem[]> {
  const rows = await sql`
    select u.id, u.last_seen_at from users u
     where u.id in (
       select o.user_id from chat_members m
         join chats c on c.id = m.chat_id and c.kind = 'direct'
         join chat_members o on o.chat_id = m.chat_id and o.user_id <> m.user_id
        where m.user_id = ${userId}
       union
       select user_id from contacts where owner_id = ${userId})`;
  return rows.map((r) => ({
    userId: r.id as number,
    online: isOnline(r.id as number),
    lastSeen: r.last_seen_at ? new Date(r.last_seen_at as string).toISOString() : null,
  }));
}

/** Только для тестов: база сброшена, id пользователей начнутся заново — забыть соединения прежних тестов. */
export function resetPresence(): void {
  for (const t of leaving.values()) clearTimeout(t);
  leaving.clear();
  conns.clear();
}
