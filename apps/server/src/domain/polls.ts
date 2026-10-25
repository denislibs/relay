import type { Message, Poll, PollInput, Update } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { enqueue } from '../jobs/queue';
import { groupCtx, hasAdmin } from './groupRights';
import { DomainError } from './errors';
import { appendUpdates, chatEvent } from './journal';
import { lockOpen, updateContent } from './messageContent';
import { blockedInDirect } from './privacy';

/**
 * Опросы и викторины, как в Telegram. Определение (вопрос, варианты, флаги, правильный ответ) хранится в
 * messages.poll шифром вместе с остальным содержимым; голоса — в poll_votes (только номера вариантов).
 *
 * У каждого читателя опрос свой: счётчики общие, а «мои» голоса и — в викторине — ответ с пояснением до голоса
 * не видны. Поэтому toMessage отдаёт определение без ответа и без итогов, а withPolls дописывает итоги для
 * конкретного читателя. Общие итоги идут событием чата pollUpdated, свои голоса — событием в свой журнал pollVoted.
 */

/** То, что лежит в messages.poll. correct — id варианта (у викторины). */
export interface PollDef {
  question: string;
  options: { id: number; text: string }[];
  multiple: boolean;
  quiz: boolean;
  anonymous: boolean;
  correct?: number;
  solution?: string;
  closesAt: string | null;
  closed: boolean;
}

/** Новый опрос из ввода клиента: варианты 1..N, правильный — из индекса в id. */
export function newPoll(input: PollInput, now = Date.now()): PollDef {
  return {
    question: input.question,
    options: input.options.map((text, i) => ({ id: i + 1, text })),
    multiple: input.multiple, quiz: input.quiz, anonymous: input.anonymous,
    ...(input.quiz && input.correct != null ? { correct: input.correct + 1 } : {}),
    ...(input.solution ? { solution: input.solution } : {}),
    closesAt: input.closesIn ? new Date(now + input.closesIn * 1000).toISOString() : null,
    closed: false,
  };
}

const isClosed = (d: PollDef, now = Date.now()) => d.closed || (d.closesAt != null && Date.parse(d.closesAt) <= now);

/** Ответ викторины спрятан в нечисловом поле: JSON.stringify его не видит, withPolls — видит. */
const HIDDEN = Symbol('pollAnswer');
type Hidden = { correct?: number; solution?: string };

/** Опрос для toMessage: без ответа викторины (пока не закрыт) и без итогов — их допишет withPolls. */
export function shownPoll(d: PollDef): Poll {
  const closed = isClosed(d);
  const poll: Poll = {
    question: d.question, options: d.options, multiple: d.multiple, quiz: d.quiz, anonymous: d.anonymous,
    closed, closesAt: d.closesAt, voters: 0, counts: d.options.map(() => 0),
    ...(closed && d.correct != null ? { correct: d.correct } : {}), ...(closed && d.solution ? { solution: d.solution } : {}),
  };
  Object.defineProperty(poll, HIDDEN, { value: { correct: d.correct, solution: d.solution } satisfies Hidden, enumerable: false });
  return poll;
}

/** Итоги одного опроса: голосов по вариантам (в порядке options) и сколько людей проголосовало. */
async function tally(db: Tx | typeof sql, chatId: number, id: number, options: { id: number }[]): Promise<{ counts: number[]; voters: number }> {
  const rows = await db`select option_id, count(*)::int as n from poll_votes where chat_id = ${chatId} and message_id = ${id} group by option_id`;
  const [v] = await db`select count(distinct user_id)::int as n from poll_votes where chat_id = ${chatId} and message_id = ${id}`;
  const by = new Map(rows.map((r) => [Number(r.option_id), Number(r.n)]));
  return { counts: options.map((o) => by.get(o.id) ?? 0), voters: Number(v?.n ?? 0) };
}

/** Итоги и мои голоса — в опросы списка сообщений (на месте), одним запросом на все опросы. */
export async function withPolls(messages: Message[], userId: number): Promise<Message[]> {
  const polls = messages.filter((m) => m.kind === 'poll' && m.poll && !m.deleted);
  if (!polls.length) return messages;
  const chats = polls.map((m) => m.chatId), ids = polls.map((m) => m.id);
  const rows = await sql`
    select v.chat_id, v.message_id, v.option_id, count(*)::int as n, bool_or(v.user_id = ${userId}) as mine
      from poll_votes v join unnest(${chats}::bigint[], ${ids}::bigint[]) as k(chat_id, message_id)
        on v.chat_id = k.chat_id and v.message_id = k.message_id
     group by v.chat_id, v.message_id, v.option_id`;
  const voters = await sql`
    select v.chat_id, v.message_id, count(distinct v.user_id)::int as n
      from poll_votes v join unnest(${chats}::bigint[], ${ids}::bigint[]) as k(chat_id, message_id)
        on v.chat_id = k.chat_id and v.message_id = k.message_id
     group by v.chat_id, v.message_id`;
  const key = (c: unknown, i: unknown) => c + ':' + i;
  const opt = new Map<string, { n: number; mine: boolean }[]>();
  for (const r of rows) {
    const k = key(r.chat_id, r.message_id);
    (opt.get(k) ?? opt.set(k, []).get(k)!)[Number(r.option_id)] = { n: Number(r.n), mine: !!r.mine };
  }
  const vot = new Map(voters.map((r) => [key(r.chat_id, r.message_id), Number(r.n)]));
  for (const m of polls) {
    const p = m.poll!, by = opt.get(key(m.chatId, m.id)) ?? [];
    p.counts = p.options.map((o) => by[o.id]?.n ?? 0);
    p.voters = vot.get(key(m.chatId, m.id)) ?? 0;
    const my = p.options.filter((o) => by[o.id]?.mine).map((o) => o.id);
    if (my.length) p.my = my;
    // проголосовал — викторина раскрывает ответ (у закрытого он уже есть)
    const h = (p as unknown as Record<symbol, Hidden>)[HIDDEN];
    if (my.length && p.quiz && h) { if (h.correct != null) p.correct = h.correct; if (h.solution) p.solution = h.solution; }
  }
  return messages;
}

async function lockPoll(tx: Tx, chatId: number, id: number) {
  const m = await lockOpen(tx, chatId, id);   // определение — в шифре: открыть под блокировкой
  if (!m || m.deleted || m.kind !== 'poll' || !m.poll) throw new DomainError('not_found', 'poll');
  return { author: Number(m.sender_id), def: m.poll as PollDef, post: !!m.post };
}

/** Общие итоги — в журнал чата одной записью; ответ викторины — только у закрытого. */
async function publish(tx: Tx, kind: 'direct' | 'group' | 'channel', chatId: number, id: number, def: PollDef): Promise<void> {
  const { counts, voters } = await tally(tx, chatId, id, def.options);
  const closed = isClosed(def);
  await chatEvent(tx, chatId, {
    type: 'pollUpdated', chatId, id, voters, counts, closed,
    ...(closed && def.correct != null ? { correct: def.correct } : {}), ...(closed && def.solution ? { solution: def.solution } : {}),
  } satisfies Update, kind);
}

/**
 * Проголосовать (или отозвать голос — пустой список). Викторину и закрытый опрос переголосовать нельзя;
 * одиночный выбор — ровно один вариант. Повтор того же — без записи.
 */
export async function votePoll(userId: number, chatId: number, id: number, options: number[]): Promise<{ changed: boolean }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId);
    if (await blockedInDirect(tx, chatId, userId)) throw new DomainError('blocked');
    const { def } = await lockPoll(tx, chatId, id);
    if (isClosed(def)) throw new DomainError('forbidden', 'closed');
    const ids = new Set(def.options.map((o) => o.id));
    const want = [...new Set(options)];
    if (want.some((x) => !ids.has(x))) throw new DomainError('bad_frame', 'option');
    if (want.length > 1 && !def.multiple) throw new DomainError('bad_frame', 'single choice');
    const had = (await tx`select option_id from poll_votes where chat_id = ${chatId} and message_id = ${id} and user_id = ${userId}`).map((r) => Number(r.option_id));
    if (had.length && def.quiz) throw new DomainError('forbidden', 'quiz answered');   // ответ викторины окончателен
    if (had.length && want.length) throw new DomainError('forbidden', 'already voted');   // сменить — сначала отозвать
    if (!had.length && !want.length) return { changed: false };
    if (want.length) await tx`insert into poll_votes ${tx(want.map((o) => ({ chat_id: chatId, message_id: id, user_id: userId, option_id: o })))} on conflict do nothing`;
    else await tx`delete from poll_votes where chat_id = ${chatId} and message_id = ${id} and user_id = ${userId}`;
    await publish(tx, ctx.kind, chatId, id, def);
    // свои голоса — всем своим устройствам; викторина после ответа раскрывает правильный вариант и пояснение
    const reveal = want.length && def.quiz ? { ...(def.correct != null ? { correct: def.correct } : {}), ...(def.solution ? { solution: def.solution } : {}) } : {};
    await appendUpdates(tx, [{ userId, update: { type: 'pollVoted', chatId, id, my: want, ...reveal } }]);
    return { changed: true };
  });
}

/** Закрыть опрос: автор (в канале — админ с правом публикации). Закрытый раскрывает ответ викторины всем. */
export async function closePoll(userId: number, chatId: number, id: number): Promise<{ changed: boolean }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId);
    const { author, def, post } = await lockPoll(tx, chatId, id);
    const may = post ? ctx.kind === 'channel' && hasAdmin(ctx, 'post') : author === userId;
    if (!may) throw new DomainError('forbidden', 'poll');
    if (def.closed) return { changed: false };
    const next: PollDef = { ...def, closed: true };
    await updateContent(tx, chatId, id, () => ({ poll: next }));
    await publish(tx, ctx.kind, chatId, id, next);
    return { changed: true };
  });
}

/** Опрос с автозакрытием: задача на его срок (poll.close). */
export async function scheduleClose(tx: Tx, chatId: number, id: number, def: PollDef): Promise<void> {
  if (def.closesAt) await enqueue(tx, 'poll.close', { chatId, id }, { runAt: new Date(def.closesAt), dedupeKey: `poll.close:${chatId}:${id}` });
}

/** Срок вышел: пометить закрытым и разослать итоги (ответ викторины теперь видят все). Повтор — без записи. */
export async function closeExpired(chatId: number, id: number): Promise<void> {
  await sql.begin(async (tx) => {
    const m = await lockOpen(tx, chatId, id);
    if (!m || m.deleted || m.kind !== 'poll' || !m.poll) return;
    const def = m.poll as PollDef;
    if (def.closed || !def.closesAt || Date.parse(def.closesAt) > Date.now()) return;
    const [c] = await tx`select kind from chats where id = ${chatId}`;
    const next: PollDef = { ...def, closed: true };
    await updateContent(tx, chatId, id, () => ({ poll: next }));
    await publish(tx, (c?.kind ?? 'group') as 'direct' | 'group' | 'channel', chatId, id, next);
  });
}

/** Кто за что голосовал (неанонимный опрос; анонимный — forbidden). По варианту — последние сначала. */
export async function pollVoters(userId: number, chatId: number, id: number): Promise<{ option: number; users: { id: number; name: string }[] }[]> {
  return sql.begin(async (tx) => {
    await groupCtx(tx, chatId, userId);   // только участник чата
    const m = await lockOpen(tx, chatId, id);
    if (!m || m.deleted || m.kind !== 'poll' || !m.poll) throw new DomainError('not_found', 'poll');
    const def = m.poll as PollDef;
    if (def.anonymous) throw new DomainError('forbidden', 'anonymous');
    const rows = await tx`
      select v.option_id, u.id, u.name from poll_votes v join users u on u.id = v.user_id
       where v.chat_id = ${chatId} and v.message_id = ${id} order by v.at desc limit 1000`;
    return def.options.map((o) => ({ option: o.id, users: rows.filter((r) => Number(r.option_id) === o.id).map((r) => ({ id: Number(r.id), name: r.name as string })) }));
  });
}
