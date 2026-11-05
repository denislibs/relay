import { SAVED_TITLE, savedPeerRule, type ForwardInfo, type Message, type ProfilePhoto, type SavedDialog, type SavedDialogsPage } from '@relay/protocol';
import { peerKey } from '../crypto/peerKey';
import { beforeCommit, sql, type Tx } from '../db';
import { toMessage } from './chats';
import { DomainError } from './errors';
import { appendUpdates } from './journal';
import { openRows } from './messageContent';
import { erase } from './messageOps';
import { nameForSql } from './profile';

/**
 * «Избранное» пользователя: существующее или новое. Личный чат с единственным участником — собой: сообщения, журнал,
 * шифр, поиск и медиа работают как в обычном личном чате, чужому его не открыть (не участник). Название лежит в
 * chats.title: поиск и прочие запросы берут coalesce(c.title, собеседник), а собеседника здесь нет.
 * Открыть — значит вернуть в список, если чат удаляли (hidden).
 */
export async function openSavedChat(userId: number): Promise<number> {
  return sql.begin(async (tx) => {
    // два устройства разом: замок по пользователю, чтобы второе не создало лишнего чата (первичный ключ — страховка)
    await tx`select pg_advisory_xact_lock(hashtextextended(${'saved:' + userId}, 0))`;
    const [found] = await tx`update saved_chats set hidden = false where user_id = ${userId} returning chat_id`;
    if (found) return Number(found.chat_id);
    const [chat] = await tx`insert into chats (kind, title) values ('direct', ${SAVED_TITLE}) returning id`;
    await tx`insert into chat_members (chat_id, user_id) values (${chat.id}, ${userId})`;
    await tx`insert into saved_chats (user_id, chat_id) values (${userId}, ${chat.id})`;
    return Number(chat.id);
  });
}

const PEER_RE = /^(me|hidden|[uc][1-9]\d{0,17})$/;
/** Параметр savedPeer из запроса: чужой мусор — отказ (значение дальше идёт только параметром SQL). */
export function savedPeerParam(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  if (!PEER_RE.test(raw)) throw new DomainError('bad_frame', 'savedPeer');
  return raw;
}

/** Чат «Избранное» этого пользователя — иначе отказ: подчаты существуют только у владельца. */
async function assertSavedOwner(db: Tx | typeof sql, chatId: number, userId: number): Promise<void> {
  const [row] = await db`select 1 from saved_chats where chat_id = ${chatId} and user_id = ${userId}`;
  if (!row) throw new DomainError('not_member');
}

/**
 * К какому подчату относится сообщение (при вставке): правила — savedPeerRule в протоколе. null — чат не «Избранное».
 * Чат-источник читается один раз, не более того, что уже видно в fwd_from: вид чата и второй участник личного чата,
 * если это моя переписка. Чужая переписка (пересланное пересланного) подчатом не становится: «Автор скрыт».
 */
export async function savedPeerFor(tx: Tx, chatId: number, fwd: ForwardInfo | null): Promise<string | null> {
  const [own] = await tx`select user_id from saved_chats where chat_id = ${chatId}`;
  if (!own) return null;
  // заголовок без чата (известно только имя) — чат-источник спрашивать не о чем: «Автор скрыт», как и у разметки миграцией
  if (!fwd || Number(fwd.chatId) === chatId || !Number.isSafeInteger(Number(fwd.chatId))) return savedPeerRule(fwd, chatId, null);
  const [src] = await tx`
    select c.id, c.kind, c.deleted_at,
           (select o.user_id from chat_members me join chat_members o on o.chat_id = me.chat_id and o.user_id <> me.user_id
             where me.chat_id = c.id and me.user_id = ${own.user_id as number} limit 1) as peer
      from chats c where c.id = ${Number(fwd.chatId)}`;
  return savedPeerRule(fwd, chatId, src ? { kind: src.kind as 'direct' | 'group' | 'channel', gone: !!src.deleted_at, peerId: src.peer == null ? null : Number(src.peer) } : null);
}

type Totals = { dialogs: number; messages: number };
const visible = () => sql`not m.deleted and (m.expires_at is null or m.expires_at > now()) and m.saved_peer is not null`;

async function savedTotals(db: Tx | typeof sql, chatId: number, historyFrom: number): Promise<Totals> {
  const [r] = await db`select count(distinct m.saved_peer)::int as dialogs, count(*)::int as messages from messages m where m.chat_id = ${chatId} and m.id >= ${historyFrom} and ${visible()}`;
  return { dialogs: r.dialogs as number, messages: r.messages as number };
}

/**
 * Подчат изменился в этой транзакции: перед коммитом владельцу — событие savedDialog с итогами (сколько в подчате, последнее,
 * всего подчатов и сообщений). Считается один раз на транзакцию, сколько бы строк она ни стёрла. Замок по владельцу:
 * параллельная транзакция посчитает уже с моей строкой, и событие с меньшим seq никогда не несёт более свежие итоги.
 * first — до записи журналов (журнал пишется хуком и после себя событий не примет).
 */
const touched = new WeakMap<object, { chatId: number; peers: Set<string> }>();
export function touchSavedDialog(tx: Tx, chatId: number, peer: string): void {
  const hit = touched.get(tx);
  if (hit) { hit.peers.add(peer); return; }
  const st = { chatId, peers: new Set([peer]) };
  touched.set(tx, st);
  beforeCommit(tx, () => flushSaved(tx, st), { first: true });
}
async function flushSaved(tx: Tx, st: { chatId: number; peers: Set<string> }): Promise<void> {
  const [own] = await tx`select s.user_id, cm.history_from from saved_chats s join chat_members cm on cm.chat_id = s.chat_id and cm.user_id = s.user_id where s.chat_id = ${st.chatId}`;
  if (!own) return;
  const userId = Number(own.user_id), from = Number(own.history_from);
  await tx`select pg_advisory_xact_lock(hashtextextended(${'saved-dialogs:' + userId}, 0))`;
  const totals = await savedTotals(tx, st.chatId, from);
  for (const peer of st.peers) {
    const [r] = await tx`select count(*)::int as n, max(m.id) as last from messages m where m.chat_id = ${st.chatId} and m.id >= ${from} and m.saved_peer = ${peer} and ${visible()}`;
    const count = r.n as number;
    // пустой подчат исчезает, закреплён он или нет: новое сообщение заведёт его заново, незакреплённым (как в Telegram)
    if (!count) await tx`delete from saved_dialog_pins where user_id = ${userId} and peer = ${peer}`;
    const [pin] = await tx`select pinned_at from saved_dialog_pins where user_id = ${userId} and peer = ${peer}`;
    await appendUpdates(tx, [{ userId, update: { type: 'savedDialog', chatId: st.chatId, peer, count, lastId: r.last == null ? null : Number(r.last), pinnedAt: pin ? new Date(pin.pinned_at as string).getTime() : null, ...totals } }]);
  }
}

/** Название и фото подчата: актуальные, но только то, что зритель и так может читать (проверка — здесь, клиенту не верим). */
type Shown = Pick<SavedDialog, 'title' | 'photo' | 'kind' | 'userId' | 'key' | 'sourceChatId' | 'access'>;
async function shownPeers(userId: number, peers: { peer: string; last: Message | null }[]): Promise<Map<string, Shown>> {
  const out = new Map<string, Shown>();
  const users = peers.filter((p) => p.peer[0] === 'u').map((p) => Number(p.peer.slice(1)));
  const chats = peers.filter((p) => p.peer[0] === 'c').map((p) => Number(p.peer.slice(1)));
  const userRows = users.length ? await sql`
    select u.id, ${nameForSql(userId)} as name, case when exists (select 1 from blocks b where b.owner_id = u.id and b.user_id = ${userId}) then null else u.photo end as photo
      from users u where u.id = any(${users}::bigint[])` : [];
  const chatRows = chats.length ? await sql`
    select c.id, c.kind, c.title, c.photo, c.username, c.deleted_at,
           exists (select 1 from chat_members m where m.chat_id = c.id and m.user_id = ${userId}) as member,
           exists (select 1 from chat_bans b where b.chat_id = c.id and b.user_id = ${userId}) as banned
      from chats c where c.id = any(${chats}::bigint[])` : [];
  const uById = new Map(userRows.map((r) => [Number(r.id), r])), cById = new Map(chatRows.map((r) => [Number(r.id), r]));
  for (const { peer, last } of peers) {
    const none: Shown = { title: null, photo: null, kind: null, access: false };
    // сохранённое в самом сообщении: ровно то, что показывает заголовок «Переслано от»
    const stored = { title: last?.fwdFrom?.name ?? null, photo: last?.fwdFrom?.photo ?? null };
    if (peer[0] === 'u') {
      const id = Number(peer.slice(1)), r = uById.get(id);
      out.set(peer, r ? { title: r.name as string, photo: (r.photo as ProfilePhoto | null) ?? null, kind: 'user', userId: id, key: peerKey(userId, id), access: true } : { ...none, ...stored, kind: 'user' });
    } else if (peer[0] === 'c') {
      const id = Number(peer.slice(1)), r = cById.get(id);
      // доступен тому, кто участник живого чата, и всем — публичный канал (те же условия, что canRead)
      const open = !!r && !r.deleted_at && (!!r.member || (r.kind === 'channel' && r.username != null && !r.banned));
      out.set(peer, open
        ? { title: (r!.title as string | null) ?? '', photo: (r!.photo as ProfilePhoto | null) ?? null, kind: r!.kind as 'group' | 'channel', sourceChatId: id, access: true }
        : { ...none, ...stored, kind: last?.fwdFrom?.userId == null ? 'channel' : 'group' });
    } else out.set(peer, none);
  }
  return out;
}

export const SAVED_DIALOGS_PAGE = 100;
/**
 * Страница подчатов: на первой — заметки и все закреплённые (позже закреплённый — выше), дальше по последнему сообщению.
 * before — lastId последней незакреплённой строки предыдущей страницы. Считается по частичному индексу из строк
 * самого чата (отдельной таблицы счётчиков нет: их пришлось бы вести на каждом пути стирания).
 */
export async function listSavedDialogs(userId: number, chatId: number, opts: { before?: number | null; limit?: number } = {}): Promise<SavedDialogsPage> {
  await assertSavedOwner(sql, chatId, userId);
  const limit = Number.isFinite(opts.limit) && opts.limit! >= 1 ? Math.min(SAVED_DIALOGS_PAGE, Math.floor(opts.limit!)) : SAVED_DIALOGS_PAGE;
  const [{ history_from }] = await sql`select history_from from chat_members where chat_id = ${chatId} and user_id = ${userId}`;
  const from = Number(history_from);
  const groups = await sql`
    select m.saved_peer as peer, count(*)::int as n, max(m.id) as last, p.pinned_at
      from messages m left join saved_dialog_pins p on p.user_id = ${userId} and p.peer = m.saved_peer
     where m.chat_id = ${chatId} and m.id >= ${from} and ${visible()}
     group by m.saved_peer, p.pinned_at`;
  const dialogs = groups.length, messages = groups.reduce((s, g) => s + (g.n as number), 0);
  const top = opts.before ? [] : groups.filter((g) => g.peer === 'me' || g.pinned_at).sort((a, b) => (a.peer === 'me' ? -1 : b.peer === 'me' ? 1 : new Date(b.pinned_at as string).getTime() - new Date(a.pinned_at as string).getTime()));
  const rest = groups.filter((g) => g.peer !== 'me' && !g.pinned_at && (!opts.before || Number(g.last) < opts.before)).sort((a, b) => Number(b.last) - Number(a.last));
  const page = [...top, ...rest.slice(0, limit)];
  const rows = page.length ? await sql`select * from messages where chat_id = ${chatId} and id = any(${page.map((g) => Number(g.last))}::bigint[])` : [];
  const byId = new Map((await openRows(rows)).map((r) => [Number(r.id), toMessage(r)]));
  const shown = await shownPeers(userId, page.map((g) => ({ peer: g.peer as string, last: byId.get(Number(g.last)) ?? null })));
  return {
    dialogs: page.map((g) => ({ peer: g.peer as string, count: g.n as number, lastId: Number(g.last), last: byId.get(Number(g.last)) ?? null, pinnedAt: g.pinned_at ? new Date(g.pinned_at as string).getTime() : null, ...shown.get(g.peer as string)! })),
    total: dialogs, messages,
    next: rest.length > limit ? Number(rest[limit - 1].last) : null,
  };
}

/** Сколько подчатов можно закрепить — как закреплённых чатов (saved_dialogs_pinned_limit в Telegram без Premium). */
export const SAVED_PIN_LIMIT = 5;
/** Закрепить или открепить подчат (операция очереди; повтор безвреден). Пустой подчат закрепить нельзя. */
export async function setSavedDialogPin(userId: number, chatId: number, rawPeer: string, pinned: unknown): Promise<{ pinnedAt: number | null }> {
  const peer = savedPeerParam(rawPeer)!;
  if (typeof pinned !== 'boolean') throw new DomainError('bad_frame', 'pinned');
  return sql.begin(async (tx) => {
    await assertSavedOwner(tx, chatId, userId);
    await tx`select pg_advisory_xact_lock(hashtextextended(${'saved-dialogs:' + userId}, 0))`;   // предел — без гонки двух устройств
    const [cur] = await tx`select pinned_at from saved_dialog_pins where user_id = ${userId} and peer = ${peer}`;
    if (!pinned) {
      if (cur) { await tx`delete from saved_dialog_pins where user_id = ${userId} and peer = ${peer}`; touchSavedDialog(tx, chatId, peer); }
      return { pinnedAt: null };
    }
    if (cur) return { pinnedAt: new Date(cur.pinned_at as string).getTime() };
    const [any] = await tx`select 1 from messages m where m.chat_id = ${chatId} and m.saved_peer = ${peer} and ${visible()} limit 1`;
    if (!any) throw new DomainError('not_found', 'dialog');
    const [{ n }] = await tx`select count(*)::int as n from saved_dialog_pins where user_id = ${userId}`;
    if ((n as number) >= SAVED_PIN_LIMIT) throw new DomainError('pin_limit');
    const [row] = await tx`insert into saved_dialog_pins (user_id, peer) values (${userId}, ${peer}) returning pinned_at`;
    touchSavedDialog(tx, chatId, peer);
    return { pinnedAt: new Date(row.pinned_at as string).getTime() };
  });
}

/**
 * Удалить подчат: все его сообщения до upToId (новые, дошедшие позже, остаются) — тем же erase, что deleteMessage: текст
 * и шифр стёрты, журнал, реакции, закрепы и поиск — как у обычного удаления. Порциями: длинная история не держит одну транзакцию.
 */
export const SAVED_ERASE_BATCH = 200;
export async function deleteSavedDialog(userId: number, chatId: number, rawPeer: string, upToId: unknown): Promise<{ ok: true; erased: number }> {
  const peer = savedPeerParam(rawPeer)!;
  const upTo = Number(upToId);
  if (!Number.isSafeInteger(upTo) || upTo <= 0) throw new DomainError('bad_frame', 'upToId');
  await assertSavedOwner(sql, chatId, userId);
  let erased = 0;
  for (;;) {
    const n = await sql.begin(async (tx) => {
      const rows = await tx`select id from messages m where m.chat_id = ${chatId} and m.id <= ${upTo} and m.saved_peer = ${peer} and not m.deleted order by m.id desc limit ${SAVED_ERASE_BATCH} for update`;
      for (const r of rows) await erase(tx, chatId, Number(r.id), 'direct');
      return rows.length;
    });
    erased += n;
    if (n < SAVED_ERASE_BATCH) return { ok: true, erased };
  }
}
