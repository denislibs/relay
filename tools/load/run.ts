/**
 * Нагрузочный прогон: N пользователей с живыми WebSocket шлют сообщения с заданной частотой.
 * Меряет: подключение (upgrade + hello), ack отправки (send → ack) и доставку (send → получатель увидел
 * сообщение в журнале: poke → sync → updates). Тело сообщения несёт время отправки — часы общие, процесс один.
 *
 *   docker compose run --rm --no-deps -v ./tools:/app/tools -e USERS=1000 -e RATE=200 server bun tools/load/run.ts
 *
 * USERS — пользователей (= сокетов), GROUP — участников в чате (2 — личные), RATE — сообщений/с всего,
 * DURATION — секунд отправки, TARGET — адрес сервера, CONNECT_RATE — новых сокетов в секунду.
 */
const env = (k: string, d: number) => Number(process.env[k] ?? d);
const USERS = env('USERS', 200), GROUP = env('GROUP', 2), RATE = env('RATE', 50), DURATION = env('DURATION', 30);
const CONNECT_RATE = env('CONNECT_RATE', 200), SETUP_PAR = env('SETUP_PAR', 16);
const TARGET = process.env.TARGET ?? 'http://server:3000';
const WS = TARGET.replace(/^http/, 'ws') + '/ws';
const RUN = Date.now().toString(36);

type Conn = { i: number; userId: number; token: string; ws?: WebSocket; seq: number; syncing: boolean; dirty: boolean; chats: number[] };

const lat = { connect: [] as number[], ack: [] as number[], deliver: [] as number[] };
const count = { sent: 0, acked: 0, ackErr: 0, delivered: 0, expected: 0, wsErrors: 0, wsClosed: 0, syncs: 0 };
const pendingAcks = new Map<string, number>();

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
const conns: Conn[] = Array.from({ length: USERS }, (_, i) => ({ i, userId: 0, token: '', seq: 0, syncing: false, dirty: false, chats: [] }));
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
console.log(`setup: ${USERS} users, ${groups.length} chats of ${GROUP} in ${Math.round(performance.now() - t0)} ms`);

// ---------- сокеты ----------
function sync(c: Conn): void {
  if (c.syncing) { c.dirty = true; return; }
  c.syncing = true; c.dirty = false; count.syncs++;
  c.ws!.send(JSON.stringify({ op: 'sync', since: c.seq }));
}

function onFrame(c: Conn, f: Record<string, unknown>, resolveHello?: () => void): void {
  switch (f.op) {
    case 'hello': c.seq = f.seq as number; resolveHello?.(); return;
    case 'poke': sync(c); return;
    case 'updates': {
      const now = performance.now();
      for (const e of f.items as { seq: number; update: { type: string; message?: { senderId: number; body: string } } }[]) {
        const m = e.update.type === 'newMessage' ? e.update.message! : null;
        if (m && m.senderId !== c.userId && m.body.startsWith('L:')) { lat.deliver.push(now - Number(m.body.slice(2))); count.delivered++; }
      }
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
    ws.onopen = () => ws.send(JSON.stringify({ op: 'hello', lastSeq: 0 }));
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
const senders = conns.filter((c) => c.chats.length && c.ws?.readyState === WebSocket.OPEN);
if (!senders.length) { console.error('no open sockets with chats — nothing to send'); process.exit(1); }
const tickMs = 10, perTick = (RATE * tickMs) / 1000;
let carry = 0, k = 0;
const ts = performance.now();
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
    c.ws!.send(JSON.stringify({ op: 'send', reqId, clientId: crypto.randomUUID(), chatId: c.chats[0], body: 'L:' + performance.now().toFixed(1) }));
    count.sent++; count.expected += GROUP - 1;
  }
  await Bun.sleep(tickMs);
}
// хвост: ждём доставку до 10 с
const tail = performance.now();
while ((count.delivered < count.expected || pendingAcks.size) && performance.now() - tail < 10_000) await Bun.sleep(100);
clearInterval(reportEvery);

const elapsed = (performance.now() - ts) / 1000;
console.log(JSON.stringify({
  params: { USERS, GROUP, RATE, DURATION },
  connect: { open, of: USERS, ...summary(lat.connect) },
  ack: { ...summary(lat.ack), errors: count.ackErr, lost: pendingAcks.size },
  deliver: { ...summary(lat.deliver), got: count.delivered, expected: count.expected },
  throughput: { sentPerSec: Math.round(count.sent / DURATION), deliveredPerSec: Math.round(count.delivered / elapsed), syncs: count.syncs },
  ws: { errors: count.wsErrors, closed: count.wsClosed },
}, null, 1));
for (const c of conns) c.ws?.close();
await Bun.sleep(500);
process.exit(0);
