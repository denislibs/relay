import type { PublicUser } from '@relay/protocol';
import { sql } from '../db';
import { COLS, publicUser, selfSeq, type ContactName, type Row } from './profile';
import { privacyCtx } from './privacy';

/** Профили людей по id — как GET /users/:id (PublicUser, правила приватности и контактные имена зрителя) + seq зрителя.
 *  Видны те же, что в getUser: общий чат, контакт зрителя и он сам; остальные молча пропускаются. Не больше 200 id.
 *  Строки и seq — из одной транзакции (repeatable read): профили «на момент seq», как у Me.seq. */
export async function usersByIds(viewer: number, ids: number[]): Promise<{ users: PublicUser[]; seq: number }> {
  const want = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  return sql.begin(async (tx) => {
    await tx`set transaction isolation level repeatable read`;
    const seq = await selfSeq(tx, viewer);
    if (!want.length) return { users: [], seq };
    const rows = await tx<Row[]>`
      select ${COLS} from users
       where id = any(${want}::bigint[]) and (id = ${viewer}
         or exists (select 1 from chat_members m join chats c on c.id = m.chat_id and c.kind <> 'channel' and c.deleted_at is null join chat_members o on o.chat_id = m.chat_id where m.user_id = ${viewer} and o.user_id = users.id)
         or exists (select 1 from contacts c where c.owner_id = ${viewer} and c.user_id = users.id)
         -- автор комментария в группе обсуждения канала, где я подписчик: его видит и гость треда (threads.ts threadAccess)
         or exists (select 1 from chat_members vm join chats ch on ch.id = vm.chat_id and ch.kind = 'channel' and ch.deleted_at is null and ch.linked_chat_id is not null
                      join messages cm on cm.sender_id = users.id and cm.chat_id = ch.linked_chat_id and cm.thread_id is not null
                     where vm.user_id = ${viewer}))`;
    if (!rows.length) return { users: [], seq };
    const found = rows.map((r) => r.id);
    const names = new Map<number, ContactName>(
      (await tx`select user_id, first_name, last_name from contacts where owner_id = ${viewer} and user_id = any(${found}::bigint[])`)
        .map((c) => [Number(c.user_id), { first_name: c.first_name as string, last_name: c.last_name as string }]));
    const ctx = await privacyCtx(tx, found.map((id) => [viewer, id]));
    return { users: rows.map((r) => publicUser(viewer, r, names.get(r.id), ctx)), seq };
  }) as Promise<{ users: PublicUser[]; seq: number }>;
}
