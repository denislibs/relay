import type { ServerFrame } from '@relay/protocol';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { nextFrame, resetDb } from './helpers';

// два отдельных процесса сервера (main.ts): своя память, общие Postgres и Valkey — как за балансировщиком
const PORTS = [3101, 3102];
const procs: ReturnType<typeof Bun.spawn>[] = [];

beforeAll(async () => {
  await resetDb();
  for (const port of PORTS) {
    procs.push(Bun.spawn(['bun', 'src/main.ts'], { cwd: import.meta.dir + '/..', env: { ...process.env, PORT: String(port), RELAY_PRESENCE_GRACE_MS: '200' }, stdout: 'inherit', stderr: 'inherit' }));
  }
  for (const port of PORTS) {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`http://localhost:${port}/health`).then((r) => r.ok, () => false)) break;
      await Bun.sleep(100);
    }
  }
});
afterAll(async () => { for (const p of procs) p.kill(); await Promise.all(procs.map((p) => p.exited)); });

const base = (i: number) => `http://localhost:${PORTS[i]}`;
async function login(name: string) {
  return (await (await fetch(`${base(0)}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
}
async function connect(i: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${PORTS[i]}/ws?token=${token}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await Bun.sleep(50);   // подписка в Valkey идёт после open
  return ws;
}

test('presence, typing and new messages cross processes; a second device keeps the user online', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const { id: chatId } = (await (await fetch(`${base(0)}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number };
  const wb = await connect(1, b.token);

  // Анна появляется на процессе 0 — Борис на процессе 1 видит «в сети»
  const online = nextFrame(wb, (f) => f.op === 'presence');
  const wa1 = await connect(0, a.token);
  expect(((await online) as Extract<ServerFrame, { op: 'presence' }>).items[0]).toMatchObject({ userId: a.userId, online: true });

  // «печатает…» — через шину
  const typing = nextFrame(wb, (f) => f.op === 'typing');
  wa1.send(JSON.stringify({ op: 'typing', chatId }));
  expect(await typing).toMatchObject({ op: 'typing', userId: a.userId });

  // сообщение — через журнал и NOTIFY
  const poke = nextFrame(wb, (f) => f.op === 'poke');
  wa1.send(JSON.stringify({ op: 'send', reqId: 'r1', chatId, clientId: crypto.randomUUID(), body: 'привет' }));
  await poke;

  // второе устройство Анны на процессе 1; закрытие первого не делает её «не в сети»
  const wa2 = await connect(1, a.token);
  const frames: ServerFrame[] = [];
  wb.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data))));
  wa1.close();
  await Bun.sleep(500);
  expect(frames.filter((f) => f.op === 'presence')).toEqual([]);

  // ушло последнее устройство — «не в сети» после паузы
  const offline = nextFrame(wb, (f) => f.op === 'presence', 3000);
  wa2.close();
  expect(((await offline) as Extract<ServerFrame, { op: 'presence' }>).items[0]).toMatchObject({ userId: a.userId, online: false });
  wb.close();
});

test('a stale pause timer from an earlier reload on another process does not swallow the next "online"', async () => {
  const a = await login('Вера'), b = await login('Глеб');
  await fetch(`${base(0)}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${a.token}` }, body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) });
  const wb = await connect(1, b.token);
  const online = nextFrame(wb, (f) => f.op === 'presence');
  const wa1 = await connect(0, a.token);
  await online;

  // «перезагрузка» с процесса 0 на процесс 1 (на 0 остаётся таймер паузы), затем вкладка закрыта
  wa1.close();
  const wa2 = await connect(1, a.token);
  wa2.close();
  const offline = nextFrame(wb, (f) => f.op === 'presence', 3000);
  expect(((await offline) as Extract<ServerFrame, { op: 'presence' }>).items[0]).toMatchObject({ userId: a.userId, online: false });

  // сразу после «не в сети» вкладка открыта снова — собеседник должен увидеть «в сети»
  const back = nextFrame(wb, (f) => f.op === 'presence', 3000);
  const wa3 = await connect(0, a.token);
  expect(((await back) as Extract<ServerFrame, { op: 'presence' }>).items[0]).toMatchObject({ userId: a.userId, online: true });
  wa3.close(); wb.close();
});
