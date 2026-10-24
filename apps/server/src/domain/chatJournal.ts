import type { JournalEntry } from '@relay/protocol';
import { sql } from '../db';
import { DomainError } from './errors';
import { hydrate, MAX_BATCH, type Stored } from './journal';

/**
 * Чтение журнала чата (запись — journal.ts chatEvent/flushJournals). У каждой группы и канала свой счётчик
 * chat_seq и записи chat_updates; участник догоняет чат кадром syncChat {chatId, since}.
 */

export async function chatSeqOf(chatId: number): Promise<number> {
  const [r] = await sql`select seq from chat_seq where chat_id = ${chatId}`;
  return r ? Number(r.seq) : 0;
}

/**
 * Записи чата после since для участника. Ссылки на сообщения до history_from (вступил при скрытой истории)
 * отдаются как messageDeleted — клиент их и так не видит. Отстал дальше, чем есть записей, — tooLong:
 * клиент перезагружает этот чат.
 */
export async function getChatUpdates(userId: number, chatId: number, since: number, limit = Number(process.env.RELAY_SYNC_BATCH) || MAX_BATCH):
  Promise<{ items: JournalEntry[]; seq: number; more: boolean; tooLong: boolean }> {
  const [m] = await sql`select history_from from chat_members where chat_id = ${chatId} and user_id = ${userId}`;
  if (!m) throw new DomainError('not_member');
  const historyFrom = Number(m.history_from ?? 0);
  const seq = await chatSeqOf(chatId);
  if (since >= seq) return { items: [], seq, more: false, tooLong: false };
  const [first] = await sql`select min(seq) as min from chat_updates where chat_id = ${chatId}`;
  if (first.min === null || since < Number(first.min) - 1) return { items: [], seq, more: false, tooLong: true };
  const rows = await sql`select seq, payload from chat_updates where chat_id = ${chatId} and seq > ${since} order by seq limit ${limit}`;
  const items = (await hydrate(null, rows.map((r) => ({ seq: Number(r.seq), payload: r.payload as Stored })))).map((it) => {
    const u = it.update;
    const id = u.type === 'newMessage' ? u.message.id : 'id' in u && typeof u.id === 'number' && u.type !== 'pins' ? u.id : null;
    return id != null && id < historyFrom ? { seq: it.seq, update: { type: 'messageDeleted' as const, chatId, id } } : it;
  });
  const last = items.length ? items[items.length - 1].seq : since;
  return { items, seq, more: last < seq, tooLong: false };
}

/**
 * Для hello {since}: группы пользователя, в которых что-то менялось после since (мс по часам базы, с запасом 5 с),
 * и текущее время базы — его клиент запомнит как следующий since. since = 0 — все группы.
 */
export async function chatSeqsSince(userId: number, sinceMs: number): Promise<{ now: number; items: [number, number][] }> {
  const since = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : 0;
  const rows = await sql`
    select cs.chat_id, cs.seq, (extract(epoch from clock_timestamp()) * 1000)::bigint as now
      from chat_members cm
      join chats c on c.id = cm.chat_id and c.kind <> 'direct'
      join chat_seq cs on cs.chat_id = cm.chat_id
     where cm.user_id = ${userId}
       and (${since}::bigint = 0 or cs.updated_at > to_timestamp(${since}::bigint / 1000.0) - interval '5 seconds')`;
  const [n] = await sql`select (extract(epoch from clock_timestamp()) * 1000)::bigint as now`;
  return { now: Number(rows[0]?.now ?? n.now), items: rows.map((r) => [Number(r.chat_id), Number(r.seq)]) };
}
