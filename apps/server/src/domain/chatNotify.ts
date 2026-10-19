import type { Update } from '@relay/protocol';
import { sql } from '../db';
import { assertMember } from './chats';
import { DomainError } from './errors';
import { appendUpdates } from './journal';

/** Из БД в протокол: навсегда ('infinity', драйвер отдаёт его невалидной датой — поэтому отдельный флаг) → 0, прошедшее время и null → null, иначе мс. */
export function muteFromDb(until: Date | null | undefined, forever: boolean | null | undefined, now = Date.now()): number | null {
  if (forever) return 0;
  if (until == null) return null;
  const ms = new Date(until).getTime();
  return Number.isFinite(ms) && ms > now ? ms : null;
}

/** Выключить уведомления чата (number — до этого времени в мс, 0 — навсегда) или включить (null). Запись — только в журнал самого пользователя. */
export async function setChatNotify(userId: number, chatId: number, body: unknown): Promise<{ muteUntil: number | null }> {
  const muteUntil = (body as { muteUntil?: unknown } | null)?.muteUntil;
  if (muteUntil !== null && !(typeof muteUntil === 'number' && Number.isSafeInteger(muteUntil) && muteUntil >= 0)) throw new DomainError('bad_frame', 'muteUntil');
  // за пределом Date (±8.64e15 мс) времени не бывает
  if (typeof muteUntil === 'number' && muteUntil > 8.64e15) throw new DomainError('bad_frame', 'muteUntil');
  await sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    // драйвер превращает параметр timestamptz в Date — 'infinity' так не передать, поэтому выражение в SQL
    const value = muteUntil === null ? sql`null` : muteUntil === 0 ? sql`'infinity'::timestamptz` : sql`to_timestamp(${muteUntil}::double precision / 1000.0)`;
    await tx`update chat_members set mute_until = ${value} where chat_id = ${chatId} and user_id = ${userId}`;
    await appendUpdates(tx, [{ userId, update: { type: 'chatNotify', chatId, muteUntil } satisfies Update }]);
  });
  return { muteUntil };
}
