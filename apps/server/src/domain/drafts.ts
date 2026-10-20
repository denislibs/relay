import { normalizeEntities, type Entity, type Update } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { assertMember } from './chats';
import { DomainError } from './errors';
import { appendUpdates } from './journal';
import { openDrafts, sealDraft } from './messageContent';

const MAX_DRAFT = 4096;

/** Сохранить черновик (пустой — удалить) и сообщить своим устройствам через журнал. Одинаковый текст — ничего не пишем. */
export async function saveDraft(userId: number, chatId: number, text: string, rawEntities?: Entity[]): Promise<{ at: string | null; changed: boolean }> {
  if (text.length > MAX_DRAFT) throw new DomainError('too_long');
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    const [prev] = await tx`select user_id, chat_id, text, entities, content from drafts where user_id = ${userId} and chat_id = ${chatId}`;
    if (prev) await openDrafts([prev]);
    const next = text.trim() ? text : '';
    const entities = next ? normalizeEntities(next, rawEntities) : [];
    if ((prev?.text ?? '') === next && JSON.stringify(normalizeEntities(next, prev?.entities)) === JSON.stringify(entities)) return { at: null, changed: false };
    let at: string | null = null;
    if (next) {
      const d = await sealDraft(userId, chatId, next, entities, tx);   // текст черновика — шифром ключа чата
      const [row] = await tx`
        insert into drafts (user_id, chat_id, text, entities, content) values (${userId}, ${chatId}, ${d.text}, ${d.entities ? sql.json(d.entities as never) : null}, ${d.content})
        on conflict (user_id, chat_id) do update set text = excluded.text, entities = excluded.entities, content = excluded.content, updated_at = now()
        returning updated_at`;
      at = new Date(row.updated_at as string).toISOString();
    } else {
      await tx`delete from drafts where user_id = ${userId} and chat_id = ${chatId}`;
    }
    await appendUpdates(tx, [{ userId, update: { type: 'draft', chatId, text: next, at: at ?? new Date().toISOString(), ...(entities.length ? { entities } : {}) } satisfies Update }]);
    return { at, changed: true };
  });
}

/** Отправили сообщение — черновик этого чата больше не нужен (в той же транзакции, что и сообщение). */
export async function clearDraftInTx(tx: Tx, userId: number, chatId: number): Promise<void> {
  const del = await tx`delete from drafts where user_id = ${userId} and chat_id = ${chatId} returning 1`;
  if (del.length) await appendUpdates(tx, [{ userId, update: { type: 'draft', chatId, text: '', at: new Date().toISOString() } }]);
}
