/**
 * Нагрузочный прогон: N пользователей с живыми WebSocket шлют сообщения с заданной частотой.
 * Меряет: подключение (upgrade + hello), ack отправки (send → ack) и доставку (send → получатель увидел
 * сообщение в журнале: poke → sync → updates). Тело сообщения несёт время отправки — часы общие, процесс один.
 *
 *   docker compose run --rm --no-deps -v ./tools:/app/tools -e USERS=1000 -e RATE=200 server bun tools/load/run.ts
 *
 * USERS — пользователей (= сокетов), GROUP — участников в чате (2 — личные), RATE — сообщений/с всего,
 * DURATION — секунд отправки, TARGET — адрес сервера, CONNECT_RATE — новых сокетов в секунду.
 *
 * KIND=channel — один канал: USERS онлайн-подписчиков (первый — владелец, первые ADMINS — админы с правом post,
 * постят они), OFFLINE — подписчиков без сокетов (вставка в chat_members пачками, members_count держит триггер).
 * expected — только онлайн-получатели. PUSH_SINK=K — первым K офлайн-подписчикам push-подписка на заглушку в этом
 * процессе (Bun.serve на SINK_PORT, адрес SINK_HOST — имя контейнера, step.sh): pushDelivered, страницы push.message
 * (NOTIFY jobs с push.message: отправка + продолжения), повторы аренды (attempts > 1). Нужен запущенный worker.
 * COMMENTS=1 — группа из USERS с привязанным каналом: все комментируют один пост (send {threadId}) с частотой RATE;
 * replies — события канала, которые видит владелец (не чаще раза в секунду на пост).
 * Подготовка этих режимов — прямо в базе (модули сервера; контейнер server), повторно используется: пользователи
 * load-ch-on-<i> / load-ch-off-<i>, канал и группа — по названию с параметрами.
 */
const env = (k: string, d: number) => Number(process.env[k] ?? d);
const USERS = env('USERS', 200), GROUP = env('GROUP', 2), RATE = env('RATE', 50), DURATION = env('DURATION', 30);
const CONNECT_RATE = env('CONNECT_RATE', 200), SETUP_PAR = env('SETUP_PAR', 16);
const KIND = process.env.KIND ?? '', COMMENTS = env('COMMENTS', 0) === 1;
const OFFLINE = env('OFFLINE', 0), ADMINS = Math.max(1, env('ADMINS', 1)), PUSH_SINK = env('PUSH_SINK', 0), SINK_PORT = env('SINK_PORT', 7900);
const SERVER_SIDE = KIND === 'channel' || COMMENTS;
const TARGET = process.env.TARGET ?? 'http://server:3000';
const WS = TARGET.replace(/^http/, 'ws') + '/ws';
const RUN = Date.now().toString(36);

type Conn = { i: number; userId: number; token: string; ws?: WebSocket; seq: number; syncing: boolean; dirty: boolean; chats: number[]; chatSeq: Map<number, number>; chatSyncing: Set<number> };

const lat = { connect: [] as number[], ack: [] as number[], deliver: [] as number[] };
const count = { sent: 0, acked: 0, ackErr: 0, delivered: 0, expected: 0, wsErrors: 0, wsClosed: 0, syncs: 0, pushed: 0, chatSyncs: 0, gaps: 0, pushDelivered: 0, pushPages: 0 };
const repliesAt: number[] = [];   // COMMENTS: когда владелец увидел replies (мс от старта отправки)
const pendingAcks = new Map<string, number>();
let sendStart = 0;

async function pool<T>(items: T[], par: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: par }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const post = async (path: string, body: unknown, token?: string) => {
  const res = await fetch(TARGET + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { cookie: `relay_session=${token}` } : {}) }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
};

function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
}
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: pct(xs, 100) });

// ---------- подготовка: пользователи и чаты ----------
const t0 = performance.now();
const conns: Conn[] = Array.from({ length: USERS }, (_, i) => ({ i, userId: 0, token: '', seq: 0, syncing: false, dirty: false, chats: [], chatSeq: new Map(), chatSyncing: new Set() }));
let senders0: Conn[] = [];        // кто отправляет (канал — админы)
let perSend = GROUP - 1;          // онлайн-получателей у одной отправки
let threadId: number | null = null;
let repliesChat = 0;              // COMMENTS: канал, где владелец ловит replies
let sinkUrl = '';
let db: typeof import('../../apps/server/src/db').sql | null = null;
if (!SERVER_SIDE) {
  await pool(conns, SETUP_PAR, async (c) => {
    const r = await post('/dev/login', { name: `load-${RUN}-${c.i}` });
    c.userId = r.userId as number; c.token = r.token as string;
  });
  const groups: Conn[][] = [];
  for (let i = 0; i + GROUP <= USERS; i += GROUP) groups.push(conns.slice(i, i + GROUP));
  await pool(groups, SETUP_PAR, async (g) => {
    const r = await post('/dev/chats', { kind: GROUP === 2 ? 'direct' : 'group', title: GROUP === 2 ? null : 'load', memberIds: g.map((c) => c.userId) }, g[0].token);
    for (const c of g) c.chats.push(r.id as number);
  });
  senders0 = conns;
  console.log(`setup: ${USERS} users, ${groups.length} chats of ${GROUP} in ${Math.round(performance.now() - t0)} ms`);
} else {
  const { sql } = await import('../../apps/server/src/db');
  db = sql;
  const { createSession } = await import('../../apps/server/src/auth');
  const { createChat, createGroup } = await import('../../apps/server/src/domain/chats');
  const { addGroupMembers, setGroupAdmin, setLinkedChat } = await import('../../apps/server/src/domain/groups');
  const { sendMessage } = await import('../../apps/server/src/domain/messages');
  /** Пользователи prefix0…prefix(n-1): недостающих — одной вставкой; id по номеру. */
  const ensureUsers = async (prefix: string, n: number): Promise<number[]> => {
    if (!n) return [];
    await sql`insert into users (name) select ${prefix} || g from generate_series(0, ${n - 1}::int) g
               where not exists (select 1 from users u where u.name = ${prefix} || g)`;
    const rows = await sql`select id, substr(name, ${prefix.length + 1})::int as i from users
                            where name like ${prefix + '%'} and substr(name, ${prefix.length + 1}) ~ '^[0-9]+$' and substr(name, ${prefix.length + 1})::int < ${n}`;
    const ids: number[] = new Array(n);
    for (const r of rows) ids[Number(r.i)] = Number(r.id);
    return ids;
  };
  const online = await ensureUsers('load-ch-on-', USERS);
  const offline = await ensureUsers('load-ch-off-', OFFLINE);
  await pool(conns, SETUP_PAR, async (c) => { c.userId = online[c.i]; c.token = await createSession(c.userId); });
  console.log(`setup: users ${USERS} online + ${OFFLINE} offline, sessions in ${Math.round(performance.now() - t0)} ms`);
  const owner = online[0];
  const findChat = async (kind: string, title: string) => {
    const [r] = await sql`select id from chats where kind = ${kind} and title = ${title} and deleted_at is null order by id desc limit 1`;
    return r ? Number(r.id) : null;
  };
  const addPaged = async (chatId: number, ids: number[]) => { for (let i = 0; i < ids.length; i += 1000) await addGroupMembers(owner, chatId, ids.slice(i, i + 1000)); };
  if (KIND === 'channel') {
    const title = `load-ch-${USERS}-${OFFLINE}-${ADMINS}`;
    let ch = await findChat('channel', title);
    if (ch == null) {
      ch = (await createGroup(owner, { kind: 'channel', title })).chatId;
      await addPaged(ch, online.slice(1));   // онлайн — обычным путём: membership с seq
      for (const a of online.slice(1, ADMINS)) await setGroupAdmin(owner, ch, a, { rights: { post: true } });
      // офлайн — прямой вставкой пачками (как insertMember: история открыта); membership им не нужен — сокетов нет
      for (let i = 0; i < offline.length; i += 10_000) {
        await sql`insert into chat_members (chat_id, user_id, inviter_id, history_from)
                  select ${ch}, unnest(${offline.slice(i, i + 10_000)}::bigint[]), ${owner}, 0 on conflict do nothing`;
      }
    }
    const [mc] = await sql`select members_count from chats where id = ${ch}`;
    for (const c of conns) c.chats.push(ch);
    senders0 = conns.slice(0, ADMINS);
    perSend = USERS - 1;
    console.log(`setup: channel ${ch} (${title}), members_count ${mc.members_count}, in ${Math.round(performance.now() - t0)} ms`);
    // подписки на заглушку прежнего прогона: её адреса больше нет — воркер повторял бы доставки в никуда
    await sql`delete from push_subscriptions where endpoint like ${'%/load-sink/%'}`;
    if (PUSH_SINK > 0) {
      // заглушка push-сервиса: считает запросы (расшифровывать незачем); подписки — первым K офлайн
      Bun.serve({ port: SINK_PORT, hostname: '0.0.0.0', fetch: async (req) => { await req.arrayBuffer(); count.pushDelivered++; return new Response(null, { status: 201 }); } });
      sinkUrl = `http://${process.env.SINK_HOST ?? (await import('node:os')).hostname()}:${SINK_PORT}/load-sink/`;
      const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
      const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))).toString('base64url');
      const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
      const subs = offline.slice(0, PUSH_SINK);
      await sql`delete from sessions where user_id = any(${subs}::bigint[])`;   // прежние подписки — каскадом
      const sids = await sql`insert into sessions (token_hash, user_id, expires_at)
                              select gen_random_uuid()::text, u, now() + interval '30 days' from unnest(${subs}::bigint[]) u returning id, user_id`;
      await sql`insert into push_subscriptions (endpoint, user_id, p256dh, auth, session_id)
                select ${sinkUrl} || s.user_id, s.user_id, ${p256dh}, ${auth}, s.id
                  from unnest(${sids.map((r) => Number(r.id))}::bigint[], ${sids.map((r) => Number(r.user_id))}::bigint[]) as s(id, user_id)`;
      console.log(`setup: ${subs.length} push subscriptions → ${sinkUrl}`);
      // страницы push.message: каждая отправка и каждое продолжение — свой NOTIFY jobs с push.message после коммита
      await sql.listen('jobs', (p) => { if (p.split(',').includes('push.message')) count.pushPages++; });
    }
  } else {
    // COMMENTS: группа из всех онлайн с привязанным каналом владельца, один пост — все комментируют его тред
    const title = `load-cm-${USERS}`;
    let g = await findChat('group', title), ch = await findChat('channel', title);
    if (g == null || ch == null) {
      ch = (await createGroup(owner, { kind: 'channel', title })).chatId;
      // группа — прямой вставкой (как /dev/chats): обмен профилями при вступлении квадратичен, на 3000 — миллионы записей
      g = await createChat('group', title, online);
      await sql`update chat_members set role = 'owner' where chat_id = ${g} and user_id = ${owner}`;
      await setLinkedChat(owner, ch, g);
    }
    const [t] = await sql`select copy_id from message_threads where chat_id = ${ch} order by post_id desc limit 1`;
    if (t) threadId = Number(t.copy_id);
    else {
      const { message } = await sendMessage(owner, { chatId: ch, clientId: crypto.randomUUID(), body: 'пост для комментариев' });
      const [r] = await sql`select copy_id from message_threads where chat_id = ${ch} and post_id = ${message.id}`;
      threadId = Number(r.copy_id);
    }
    for (const c of conns) c.chats.push(g);
    conns[0].chats.push(ch);
    repliesChat = ch;
    senders0 = conns;
    perSend = USERS - 1;
    console.log(`setup: group ${g} + channel ${ch}, thread ${threadId}, in ${Math.round(performance.now() - t0)} ms`);
  }
}

// ---------- сокеты ----------
function sync(c: Conn): void {
  if (c.syncing) { c.dirty = true; return; }
  c.syncing = true; c.dirty = false; count.syncs++;
  c.ws!.send(JSON.stringify({ op: 'sync', since: c.seq }));
}

/** Журнал чата (группы): как движок — push с from === номер чата применяем, иначе syncChat. */
function syncChat(c: Conn, chatId: number): void {
  if (c.chatSyncing.has(chatId)) return;
  c.chatSyncing.add(chatId); count.chatSyncs++;
  c.ws!.send(JSON.stringify({ op: 'syncChat', reqId: 'c' + chatId, chatId, since: c.chatSeq.get(chatId) ?? 0 }));
}
/** Тело отправки — «L:<время>:<номер отправителя>»: у поста канала senderId 0, своё узнаём по номеру. */
function sentAt(c: Conn, m: { body: string } | null): number | null {
  if (!m || !m.body.startsWith('L:')) return null;
  const [, at, from] = m.body.split(':');
  return Number(from) === c.i ? null : Number(at);
}
function countDelivered(c: Conn, items: { update: { type: string; chatId?: number; message?: { senderId: number; body: string } } }[], now: number): void {
  for (const e of items) {
    const at = sentAt(c, e.update.type === 'newMessage' ? e.update.message! : null);
    if (at != null) { lat.deliver.push(now - at); count.delivered++; }
    if (e.update.type === 'replies' && c.i === 0 && e.update.chatId === repliesChat && sendStart) repliesAt.push(now - sendStart);
  }
}

function onFrame(c: Conn, f: Record<string, unknown>, resolveHello?: () => void): void {
  switch (f.op) {
    case 'hello': {
      c.seq = f.seq as number;
      // группы: номера из hello (since = 0 — все); догонять нечего, старт с текущего
      for (const [chatId, seq] of (f.chats as [number, number][]) ?? []) c.chatSeq.set(chatId, seq);
      resolveHello?.(); return;
    }
    case 'chatUpdates': {
      const chatId = f.chatId as number;
      countDelivered(c, f.items as never, performance.now());
      c.chatSeq.set(chatId, f.to as number);
      c.chatSyncing.delete(chatId);
      if (f.more) syncChat(c, chatId);
      return;
    }
    case 'chatTooLong': { c.chatSeq.set(f.chatId as number, f.seq as number); c.chatSyncing.delete(f.chatId as number); return; }
    case 'chatGone': { c.chatSyncing.delete(f.chatId as number); c.chatSeq.delete(f.chatId as number); return; }
    case 'poke': sync(c); return;
    case 'push': {
      if (f.chatId != null) {
        // журнал чата: применяем, если ровно следующая запись; иначе — догонка этого чата
        const chatId = f.chatId as number, local = c.chatSeq.get(chatId);
        const items = f.items as never[];
        if (local == null) { c.chatSeq.set(chatId, (f.from as number)); }   // чат, которого не знали: начинаем с него
        if (c.chatSyncing.has(chatId) || f.from !== c.chatSeq.get(chatId) || !items.length) { count.gaps++; syncChat(c, chatId); return; }
        countDelivered(c, items, performance.now()); count.pushed++;
        c.chatSeq.set(chatId, f.to as number);
        return;
      }
      // личный журнал: применяем, если ровно следующая, иначе — обычная синхронизация
      if (c.syncing || f.from !== c.seq) { sync(c); return; }
      const now = performance.now();
      for (const e of f.items as { seq: number; update: { type: string; message?: { senderId: number; body: string } } }[]) {
        const at = sentAt(c, e.update.type === 'newMessage' ? e.update.message! : null);
        if (at != null) { lat.deliver.push(now - at); count.delivered++; count.pushed++; }
      }
      c.seq = f.to as number;
      return;
    }
    case 'updates': {
      countDelivered(c, f.items as never, performance.now());
      c.seq = f.to as number;
      c.syncing = false;
      if (f.more || c.dirty) sync(c);
      return;
    }
    case 'ack': {
      const at = pendingAcks.get(f.reqId as string);
      if (at != null) { pendingAcks.delete(f.reqId as string); lat.ack.push(performance.now() - at); count.acked++; }
      return;
    }
    case 'err': {
      if (pendingAcks.delete(f.reqId as string)) count.ackErr++;
      else if (c.syncing) { c.syncing = false; }
      return;
    }
  }
}

function connect(c: Conn): Promise<void> {
  const started = performance.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const ws = new WebSocket(WS, { headers: { cookie: `relay_session=${c.token}` } } as unknown as string[]);
    c.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ op: 'hello', lastSeq: 0, since: 0 }));
    ws.onmessage = (e) => onFrame(c, JSON.parse(String(e.data)), () => { lat.connect.push(performance.now() - started); finish(); });
    ws.onerror = () => { count.wsErrors++; finish(); };
    ws.onclose = () => { count.wsClosed++; finish(); };
    setTimeout(finish, 15_000);
  });
}

const tc = performance.now();
const waits: Promise<void>[] = [];
for (const c of conns) {
  waits.push(connect(c));
  if (CONNECT_RATE > 0) await Bun.sleep(1000 / CONNECT_RATE);
}
await Promise.all(waits);
const open = conns.filter((c) => c.ws?.readyState === WebSocket.OPEN).length;
console.log(`connect: ${open}/${USERS} open in ${Math.round(performance.now() - tc)} ms`, summary(lat.connect));

// ---------- отправка ----------
const senders = senders0.filter((c) => c.chats.length && c.ws?.readyState === WebSocket.OPEN);
if (!senders.length) { console.error('no open sockets with chats — nothing to send'); process.exit(1); }
const tickMs = 10, perTick = (RATE * tickMs) / 1000;
let carry = 0, k = 0;
const ts = performance.now();
sendStart = ts;
// повторы аренды: задачи push.* с attempts > 1 (опрос раз в 500 мс; строка живёт до конца задачи)
const leaseSeen = new Set<number>();
const deadBefore = db ? Number((await db`select count(*)::int as n from jobs_dead`)[0].n) : 0;
const leasePoll = db && PUSH_SINK ? setInterval(() => {
  db!`select id from jobs where kind like 'push.%' and attempts > 1`.then((rows) => { for (const r of rows) leaseSeen.add(Number(r.id)); }).catch(() => {});
}, 500) : null;
const reportEvery = setInterval(() => {
  console.log(`  t=${Math.round((performance.now() - ts) / 1000)}s sent=${count.sent} acked=${count.acked} delivered=${count.delivered}/${count.expected} pendingAcks=${pendingAcks.size}`);
}, 5000);
while (performance.now() - ts < DURATION * 1000) {
  carry += perTick;
  while (carry >= 1) {
    carry -= 1;
    const c = senders[k++ % senders.length];
    const reqId = crypto.randomUUID();
    pendingAcks.set(reqId, performance.now());
    c.ws!.send(JSON.stringify({ op: 'send', reqId, clientId: crypto.randomUUID(), chatId: c.chats[0], body: `L:${performance.now().toFixed(1)}:${c.i}`, ...(threadId != null ? { threadId } : {}) }));
    count.sent++; count.expected += perSend;
  }
  await Bun.sleep(tickMs);
}
// хвост: ждём доставку до 10 с
const tail = performance.now();
while ((count.delivered < count.expected || pendingAcks.size) && performance.now() - tail < 10_000) await Bun.sleep(100);
// push: ждём, пока воркер разошлёт всё (до TAIL_PUSH секунд), — каждому подписчику по push на пост
const pushExpected = PUSH_SINK ? count.acked * Math.min(PUSH_SINK, OFFLINE) : 0;
const pushTail = performance.now();
let pushDoneMs = 0;
while (PUSH_SINK && count.pushDelivered < pushExpected && performance.now() - pushTail < env('TAIL_PUSH', 300) * 1000) {
  await Bun.sleep(200);
  if (performance.now() - pushTail > 5000 && Math.round((performance.now() - pushTail) / 1000) % 10 === 0) console.log(`  push ${count.pushDelivered}/${pushExpected}`);
}
if (PUSH_SINK) pushDoneMs = Math.round(performance.now() - ts);
if (leasePoll) clearInterval(leasePoll);
// заглушка уходит вместе с процессом — её подписки тоже
if (db && PUSH_SINK) await db`delete from push_subscriptions where endpoint like ${'%/load-sink/%'}`;
const deadAfter = db ? Number((await db`select count(*)::int as n from jobs_dead`)[0].n) : 0;
clearInterval(reportEvery);
/** replies владельцу: сколько и наибольшее число за одну секунду (окна по секунде от старта). */
const perSecond = new Map<number, number>();
for (const t of repliesAt) perSecond.set(Math.floor(t / 1000), (perSecond.get(Math.floor(t / 1000)) ?? 0) + 1);

const elapsed = (performance.now() - ts) / 1000;
console.log(JSON.stringify({
  params: { USERS, GROUP, RATE, DURATION, ...(SERVER_SIDE ? { KIND, COMMENTS, OFFLINE, ADMINS, PUSH_SINK } : {}) },
  connect: { open, of: USERS, ...summary(lat.connect) },
  ack: { ...summary(lat.ack), errors: count.ackErr, lost: pendingAcks.size },
  deliver: { ...summary(lat.deliver), got: count.delivered, expected: count.expected },
  throughput: { sentPerSec: Math.round(count.sent / DURATION), deliveredPerSec: Math.round(count.delivered / elapsed), syncs: count.syncs, pushed: count.pushed, chatSyncs: count.chatSyncs, gaps: count.gaps },
  ws: { errors: count.wsErrors, closed: count.wsClosed },
  ...(PUSH_SINK ? { push: { pushDelivered: count.pushDelivered, expected: pushExpected, pushPages: count.pushPages, pagesExpected: count.acked * Math.ceil(Math.min(PUSH_SINK, OFFLINE) / 1000), leaseRetries: leaseSeen.size, dead: deadAfter - deadBefore, doneMs: pushDoneMs } } : {}),
  ...(COMMENTS ? { replies: { events: repliesAt.length, seconds: Math.round(elapsed), maxPerSecond: Math.max(0, ...perSecond.values()),
    minGapMs: Math.round(Math.min(...repliesAt.slice(1).map((t, i) => t - repliesAt[i]))) } } : {}),
}, null, 1));
for (const c of conns) c.ws?.close();
await Bun.sleep(500);
process.exit(0);
