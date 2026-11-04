import { blockedInDirect } from './privacy';
import { normalizeEntities, rightForKind, SCHEDULED_LIMIT, SCHEDULE_MAX_MS, trimFormatted, type Attachment, type Entity, type ErrorCode, type ScheduledMessage, type StickerRef } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { CryptoError, keyVersionOf, open, seal } from '../crypto/aead';
import { chatKey, currentChatKey } from '../crypto/chatKeys';
import { enqueue } from '../jobs/queue';
import { clearDraftInTx } from './drafts';
import { DomainError } from './errors';
import { attachmentForSend } from './files';
import { groupCtx, hasAdmin, requireRight } from './groupRights';
import { appendUpdates } from './journal';
import { MAX_BODY, sendMessage } from './messages';
import { postService } from './service';
import { stickerForSend } from './stickers';

/**
 * Отложенные сообщения. До публикации живут только в scheduled_messages: в messages их нет, поэтому поиск, счётчики,
 * медиа чата и Meilisearch их не знают, а другие участники не видят. Текст и снимки вложения и стикера — только шифром
 * ключа чата (AAD «scheduled|чат|автор|client_id»), в задачах и журнале — ссылка (client_id).
 *
 * Публикация — обычный sendMessage в момент срабатывания: права, блокировка, приватность, журнал и push проверяются тогда
 * же. Строка держится под блокировкой в его транзакции и удаляется в ней же, поэтому сообщение появляется ровно один раз:
 * повтор задачи или второй воркер строки уже не найдут. Задача ставится на send_at (scheduled.send); смена времени ставит
 * новую, старая придёт раньше срока и ничего не сделает. scheduled.sweep подбирает то, чья задача умерла.
 *
 * Отправить нельзя (выгнали, заблокировали, удалён чат): сообщение не уходит, автору — служебное сообщение от «Relay»
 * (видно откуда угодно, приходит и push). Чат ещё доступен — строка остаётся с failed: в списке видна ошибка, текст не
 * пропал, можно изменить или удалить; чата больше нет — строка удаляется (списка, где её увидеть, тоже нет).
 */

/** Полезная нагрузка шифра: что нужно для показа в списке и для публикации. */
interface Sealed { b: string; e: Entity[] | null; a?: Attachment | null; s?: StickerRef | null; n?: boolean }

const aad = (chatId: number, userId: number, clientId: string) => `scheduled|${chatId}|${userId}|${clientId}`;

async function sealContent(chatId: number, userId: number, clientId: string, c: Sealed, tx?: Tx): Promise<Buffer> {
  const k = await currentChatKey(chatId, tx);
  return Buffer.from(await seal(k.key, k.version, JSON.stringify(c), aad(chatId, userId, clientId)));
}

/** null — ключ чата уничтожен: содержимого больше нет. */
async function openContent(r: Record<string, unknown>, tx?: Tx): Promise<Sealed | null> {
  const s = new Uint8Array(r.content as Uint8Array), chatId = Number(r.chat_id);
  try {
    return JSON.parse(await open(await chatKey(chatId, keyVersionOf(s), tx), s, aad(chatId, Number(r.user_id), r.client_id as string))) as Sealed;
  } catch (e) {
    if (e instanceof CryptoError && e.code === 'no_key') return null;
    throw e;
  }
}

export async function toItem(r: Record<string, unknown>, tx?: Tx): Promise<ScheduledMessage> {
  const c = await openContent(r, tx);
  return {
    clientId: r.client_id as string, chatId: Number(r.chat_id), sendAt: new Date(r.send_at as string).getTime(), kind: r.kind as ScheduledMessage['kind'],
    body: c?.b ?? '', ...(c?.e?.length ? { entities: c.e } : {}), replyToId: r.reply_to_id == null ? null : Number(r.reply_to_id),
    ...(c?.a ? { attachment: c.a } : {}), ...(r.group_id ? { groupId: r.group_id as string } : {}), ...(c?.s ? { sticker: c.s } : {}),
    ...(r.silent ? { silent: true } : {}), ...(!c ? { failed: 'not_found' } : r.failed ? { failed: r.failed as string } : {}),
    rev: Number(r.rev), createdAt: new Date(r.created_at as string).toISOString(),
  };
}

/** Отложенные одного человека по client_id (журнал: подстановка ссылок). */
export async function scheduledByIds(userId: number, ids: string[]): Promise<Map<string, ScheduledMessage>> {
  const rows = await sql`select * from scheduled_messages where user_id = ${userId} and client_id = any(${ids}::uuid[])`;
  return new Map(await Promise.all(rows.map(async (r) => [r.client_id as string, await toItem(r)] as const)));
}

/** Все отложенные человека: снимок для устройства (дальше — журнал). */
export async function listScheduled(userId: number): Promise<{ items: ScheduledMessage[] }> {
  const rows = await sql`select * from scheduled_messages where user_id = ${userId} order by send_at limit 10000`;
  return { items: await Promise.all(rows.map((r) => toItem(r))) };
}

function checkTime(at: number): void {
  if (!Number.isSafeInteger(at) || at <= Date.now()) throw new DomainError('schedule_past');
  if (at > Date.now() + SCHEDULE_MAX_MS + 24 * 3600_000) throw new DomainError('schedule_far');
}

/** Задача публикации. Ключ со временем: то же время — та же задача, новое — своя. */
const queueSend = (tx: Tx | typeof sql, userId: number, clientId: string, at: number) =>
  enqueue(tx, 'scheduled.send', { userId, clientId }, { runAt: new Date(at), dedupeKey: `scheduled:${clientId}:${at}`, maxAttempts: 30 });

type ScheduleInput = {
  chatId: number; clientId: string; body: string; entities?: Entity[]; replyToId?: number | null; attachment?: { id: string; thumb?: string | null; spoiler?: boolean } | null;
  groupId?: string | null; noLinkPreview?: boolean; sticker?: { id: number } | null; draftHash?: string | null; silent?: boolean; scheduleAt?: number;
  forward?: unknown; blocks?: unknown; todo?: unknown; poll?: unknown; contact?: unknown; geo?: unknown; dice?: unknown; threadId?: number | null;
};

/**
 * Запланировать (кадр send со scheduleAt). Повтор кадра не создаёт второй строки; уже опубликованное отвечает published
 * (ответ потерялся, а время прошло). Права проверяются и здесь, чтобы отказать сразу, и в момент публикации.
 */
export async function scheduleMessage(userId: number, input: ScheduleInput): Promise<{ item: ScheduledMessage } | { published: true }> {
  // опросы, чек-листы, кубики, статьи, геопозиция и комментарии отложить нельзя: пункта меню для них нет
  if (input.forward || input.blocks != null || input.todo || input.poll || input.contact || input.geo || input.dice || input.threadId != null) throw new DomainError('bad_frame', 'schedule kind');
  const stickerId = input.sticker ? input.sticker.id : null;
  if (stickerId != null && input.attachment) throw new DomainError('bad_frame', 'sticker with attachment');
  const { text: body, entities } = stickerId != null ? { text: '', entities: [] as Entity[] } : trimFormatted(input.body, normalizeEntities(input.body, input.entities));
  if (!body && !input.attachment && stickerId == null) throw new DomainError('bad_frame', 'empty body');
  if (body.length > MAX_BODY) throw new DomainError('too_long');
  const at = input.scheduleAt!;
  await currentChatKey(input.chatId).catch(() => {});
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, input.chatId, userId);
    const [again] = await tx`select * from scheduled_messages where user_id = ${userId} and client_id = ${input.clientId}`;
    if (again) return { item: await toItem(again, tx) };
    if ((await tx`select 1 from messages where sender_id = ${userId} and client_id = ${input.clientId}`).length) return { published: true as const };
    checkTime(at);
    if (await blockedInDirect(tx, input.chatId, userId)) throw new DomainError('blocked');
    if (ctx.kind === 'channel') {
      if (!hasAdmin(ctx, 'post')) throw new DomainError('forbidden', 'post');
      if (input.replyToId != null) throw new DomainError('bad_frame', 'reply in channel');
    }
    if (input.replyToId != null) {
      const [target] = await tx`select 1 from messages where chat_id = ${input.chatId} and id = ${input.replyToId} and not deleted`;
      if (!target) throw new DomainError('not_found', 'reply target');
    }
    const attachment = input.attachment ? await attachmentForSend(tx, userId, input.attachment) : null;
    const sticker = stickerId != null ? await stickerForSend(tx, userId, stickerId) : null;
    const kind = sticker ? 'sticker' : attachment ? attachment.kind : 'text';
    requireRight(ctx, rightForKind(kind, attachment?.mime));
    // лимит на чат: две вставки разом не должны проскочить мимо счёта
    await tx`select pg_advisory_xact_lock(hashtextextended(${`scheduled:${userId}:${input.chatId}`}, 0))`;
    const [{ n }] = await tx`select count(*)::int as n from scheduled_messages where user_id = ${userId} and chat_id = ${input.chatId}`;
    if ((n as number) >= SCHEDULED_LIMIT) throw new DomainError('schedule_limit');
    const content = await sealContent(input.chatId, userId, input.clientId, { b: body, e: entities.length ? entities : null, ...(attachment ? { a: attachment } : {}), ...(sticker ? { s: sticker } : {}), ...(input.noLinkPreview ? { n: true } : {}) }, tx);
    const groupId = attachment && input.groupId && /^[0-9a-f-]{36}$/.test(input.groupId) ? input.groupId : null;
    const [row] = await tx`
      insert into scheduled_messages (user_id, client_id, chat_id, kind, send_at, silent, reply_to_id, group_id, attachment_id, content)
      values (${userId}, ${input.clientId}, ${input.chatId}, ${kind}, ${new Date(at)}, ${!!input.silent}, ${input.replyToId ?? null}, ${groupId}, ${attachment?.id ?? null}, ${content})
      returning *`;
    const item = await toItem(row, tx);
    await appendUpdates(tx, [{ userId, update: { type: 'scheduled', item } }]);
    await queueSend(tx, userId, input.clientId, at);
    // запланировали из поля ввода: черновик ушёл вместе с текстом (как при отправке)
    if (input.draftHash !== null) await clearDraftInTx(tx, userId, input.chatId, input.draftHash);
    return { item };
  });
}

const lockRow = async (tx: Tx, userId: number, chatId: number, clientId: string) =>
  (await tx`select * from scheduled_messages where user_id = ${userId} and client_id = ${clientId} and chat_id = ${chatId} for update`)[0];

/** Правка: время, текст или «отправить сейчас» (send). Чужая строка не находится: not_found, как и несуществующая. */
export async function editScheduled(userId: number, chatId: number, clientId: string, raw: unknown): Promise<{ item?: ScheduledMessage; sent?: true }> {
  const p = (raw && typeof raw === 'object' ? raw : {}) as { sendAt?: unknown; body?: unknown; entities?: unknown; send?: unknown };
  const send = p.send === true;
  if (!send && p.sendAt !== undefined) checkTime(p.sendAt as number);
  if (p.body !== undefined && typeof p.body !== 'string') throw new DomainError('bad_frame', 'body');
  await currentChatKey(chatId).catch(() => {});
  const item = await sql.begin(async (tx) => {
    const row = await lockRow(tx, userId, chatId, clientId);
    if (!row) throw new DomainError('not_found', 'scheduled');
    let content = row.content as Buffer;
    if (p.body !== undefined) {
      const c = await openContent(row, tx);
      if (!c) throw new DomainError('not_found', 'scheduled');
      if (row.kind === 'sticker') throw new DomainError('bad_frame', 'sticker text');
      const body = p.body as string, { text, entities } = trimFormatted(body, normalizeEntities(body, p.entities));
      if (!text && !c.a) throw new DomainError('bad_frame', 'empty body');
      if (text.length > MAX_BODY) throw new DomainError('too_long');
      content = await sealContent(chatId, userId, clientId, { ...c, b: text, e: entities.length ? entities : null }, tx);
    }
    const at = send ? new Date() : p.sendAt !== undefined ? new Date(p.sendAt as number) : new Date(row.send_at as string);
    // правка только текста у того, что не ушло, не отправляет его заново: повторить — новое время или «отправить сейчас»
    const keepFailed = !send && p.sendAt === undefined && row.failed != null;
    const [next] = await tx`update scheduled_messages set send_at = ${at}, content = ${content}, rev = rev + 1, failed = ${keepFailed ? row.failed as string : null}
                             where user_id = ${userId} and client_id = ${clientId} returning *`;
    const out = await toItem(next, tx);
    await appendUpdates(tx, [{ userId, update: { type: 'scheduled', item: out } }]);
    if (!keepFailed) await queueSend(tx, userId, clientId, at.getTime());   // в т. ч. «отправить сейчас»: сбой ниже подберёт задача
    return out;
  });
  if (!send) return { item };
  await publishOne(userId, clientId, true).catch((e) => console.error('scheduled send:', e));
  const [left] = await sql`select * from scheduled_messages where user_id = ${userId} and client_id = ${clientId}`;
  return left ? { item: await toItem(left) } : { sent: true };
}

/** Удалить. Уже опубликованное или чужое — молча: отвечать по-разному значило бы раскрывать чужие строки. */
export async function deleteScheduled(userId: number, chatId: number, clientId: string): Promise<{ ok: true }> {
  await sql.begin(async (tx) => {
    const gone = await tx`delete from scheduled_messages where user_id = ${userId} and client_id = ${clientId} and chat_id = ${chatId} returning 1`;
    if (gone.length) await appendUpdates(tx, [{ userId, update: { type: 'scheduledRemoved', chatId, clientId } }]);
  });
  return { ok: true };
}

/** Строка изменилась, пока её читали (правка): публикация начнётся заново с новым содержимым. */
class Stale extends Error {}

/** Задача scheduled.send: 'again' — повторить через inSec; остальное — готово (или делать нечего). */
export async function publishScheduled(userId: number, clientId: string): Promise<{ again: { inSec: number } } | void> {
  const [row] = await sql`select chat_id, group_id, send_at, failed from scheduled_messages where user_id = ${userId} and client_id = ${clientId}`;
  if (!row || row.failed || new Date(row.send_at as string).getTime() > Date.now()) return;   // опубликовано, удалено, отложено дальше
  // альбом — в порядке постановки и одной задачей: задачи файлов идут параллельно и перемешали бы его. Чужая задача того же
  // альбома придёт за теми же строками: блокировка строки выстроит их по очереди, опубликованную она уже не найдёт
  const ids = row.group_id ? (await sql`
    select client_id from scheduled_messages where user_id = ${userId} and chat_id = ${row.chat_id} and group_id = ${row.group_id} and failed is null and send_at <= now()
     order by created_at, client_id`).map((r) => r.client_id as string) : [clientId];
  let again: number | null = null;
  for (const id of ids) {
    const r = await publishOne(userId, id, false);
    if (r != null) again = Math.max(again ?? 0, r);
  }
  if (again != null) return { again: { inSec: again } };
}

/** Опубликовать одну строку. Вернёт секунды до повтора (медленный режим, правка посреди публикации) или null. */
async function publishOne(userId: number, clientId: string, force: boolean): Promise<number | null> {
  const [row] = await sql`select * from scheduled_messages where user_id = ${userId} and client_id = ${clientId}`;
  if (!row) return null;
  const chatId = Number(row.chat_id), rev = Number(row.rev);
  const c = await openContent(row);
  if (!c) { await failScheduled(row, 'not_found'); return null; }
  const silent = !!row.silent;
  // себе в «Избранное» — напоминание: автору приходит обычное уведомление (если не «без звука»)
  const saved = (await sql`select 1 from saved_chats where user_id = ${userId} and chat_id = ${chatId}`).length > 0;
  const send = (replyToId: number | null) => sendMessage(userId, {
    chatId, clientId, body: c.b, entities: c.e ?? [], replyToId, draftHash: null, silent, reminder: saved && !silent,
    ...(row.group_id ? { groupId: row.group_id as string } : {}), ...(c.n ? { noLinkPreview: true } : {}),
    ...(c.a ? { attachment: { id: c.a.id, thumb: c.a.thumb ?? null, ...(c.a.spoiler ? { spoiler: true } : {}) } } : {}), ...(c.s ? { sticker: { id: c.s.id } } : {}),
  }, {
    before: async (tx) => {
      const [cur] = await tx`select rev, failed, send_at from scheduled_messages where user_id = ${userId} and client_id = ${clientId} for update`;
      if (!cur || Number(cur.rev) !== rev || (!force && cur.failed)) throw new Stale();
    },
    after: async (tx) => {
      await tx`delete from scheduled_messages where user_id = ${userId} and client_id = ${clientId}`;
      await appendUpdates(tx, [{ userId, update: { type: 'scheduledRemoved', chatId, clientId } }]);
    },
  });
  try {
    try { await send(row.reply_to_id == null ? null : Number(row.reply_to_id)); }
    catch (e) {
      // сообщение, на которое отвечали, удалили: уходит без цитаты (как в Telegram), это не повод не отправлять
      if (e instanceof DomainError && e.code === 'not_found' && e.message === 'reply target') await send(null);
      else throw e;
    }
    return null;
  } catch (e) {
    if (e instanceof Stale) return 0;
    if (!(e instanceof DomainError)) throw e;
    if (e.code === 'flood') return 30;   // медленный режим: не отказ, очередь просто подождёт
    await failScheduled(row, e.code);
    return null;
  }
}

/** Человеческая причина для служебного сообщения. */
const REASON: Partial<Record<ErrorCode, string>> = {
  not_member: 'вы больше не участник этого чата',
  not_found: 'чат или вложение больше не существует',
  blocked: 'собеседник ограничил отправку сообщений',
  forbidden: 'у вас больше нет права писать в этот чат',
  bad_frame: 'сообщение не удалось подготовить',
  too_long: 'сообщение слишком длинное',
};

async function chatName(tx: Tx, chatId: number, userId: number): Promise<string> {
  const [c] = await tx`select coalesce(c.title, (select u.name from chat_members m join users u on u.id = m.user_id where m.chat_id = c.id and m.user_id <> ${userId} limit 1)) as name from chats c where c.id = ${chatId}`;
  return (c?.name as string | null) ?? 'чат';
}

const failText = (name: string, reason: string) => `Отложенное сообщение в «${name}» не отправлено: ${reason}.`;

/** Отказ в момент публикации: чат доступен — строка остаётся с ошибкой, иначе удаляется; автору — сообщение от «Relay». */
async function failScheduled(row: Record<string, unknown>, code: ErrorCode): Promise<void> {
  const userId = Number(row.user_id), chatId = Number(row.chat_id), clientId = row.client_id as string;
  await sql.begin(async (tx) => {
    const [cur] = await tx`select rev from scheduled_messages where user_id = ${userId} and client_id = ${clientId} for update`;
    if (!cur) return;
    const [member] = await tx`select 1 from chat_members m join chats c on c.id = m.chat_id and c.deleted_at is null where m.chat_id = ${chatId} and m.user_id = ${userId}`;
    if (member && code !== 'not_found' && code !== 'not_member') {
      const [next] = await tx`update scheduled_messages set failed = ${code}, rev = rev + 1 where user_id = ${userId} and client_id = ${clientId} returning *`;
      await appendUpdates(tx, [{ userId, update: { type: 'scheduled', item: await toItem(next, tx) } }]);
    } else {
      await tx`delete from scheduled_messages where user_id = ${userId} and client_id = ${clientId}`;
      await appendUpdates(tx, [{ userId, update: { type: 'scheduledRemoved', chatId, clientId } }]);
    }
    await postService(tx, userId, { type: 'scheduled_failed', body: failText(await chatName(tx, chatId, userId), REASON[code] ?? 'отправка больше невозможна') });
  });
}

/** Чат удаляют у who («удалить чат»): их отложенные уходят вместе с ним. Другим людям (не actor) — сообщение от «Relay». */
export async function dropScheduledInChat(tx: Tx, chatId: number, who: number[], actor: number | null): Promise<void> {
  const rows = await tx`delete from scheduled_messages where chat_id = ${chatId} and user_id = any(${who}::bigint[]) returning user_id, client_id`;
  if (!rows.length) return;
  await appendUpdates(tx, rows.map((r) => ({ userId: Number(r.user_id), update: { type: 'scheduledRemoved' as const, chatId, clientId: r.client_id as string } })));
  const affected = new Set(rows.map((r) => Number(r.user_id)));
  affected.delete(actor as number);
  for (const userId of affected) await postService(tx, userId, { type: 'scheduled_failed', body: failText(await chatName(tx, chatId, userId), 'чат удалён') });
}

/** Группу или канал вычищают насовсем (chat.purge): строки уйдут каскадом — авторы должны об этом узнать. */
export async function dropScheduledOfPurged(tx: Tx, chatId: number): Promise<void> {
  const who = (await tx`select distinct user_id from scheduled_messages where chat_id = ${chatId}`).map((r) => Number(r.user_id));
  if (who.length) await dropScheduledInChat(tx, chatId, who, null);
}

/** Страховка очереди (scheduled.sweep): срок прошёл, а задачи нет (умерла после всех попыток) — поставить заново. */
export async function sweepScheduled(): Promise<number> {
  const rows = await sql`select user_id, client_id, send_at from scheduled_messages where failed is null and send_at < now() - interval '1 minute' order by send_at limit 1000`;
  for (const r of rows) await queueSend(sql, Number(r.user_id), r.client_id as string, new Date(r.send_at as string).getTime());
  return rows.length;
}
