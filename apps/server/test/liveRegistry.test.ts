import { beforeEach, expect, test } from 'bun:test';
import { connect, connectionCount, disconnect, leave, onlineUsers, processAlive, processGone } from '../src/domain/liveRegistry';
import { resetDb } from './helpers';

process.env.RELAY_PRESENCE_GRACE_MS = '300';
beforeEach(resetDb);

const P1 = 'proc-1', P2 = 'proc-2';
beforeEach(async () => { await processAlive(P1); await processAlive(P2); });

test('totals count sockets across processes', async () => {
  expect(await connect(7, P1)).toEqual({ total: 1, returning: false });
  expect(await connect(7, P2)).toEqual({ total: 2, returning: false });
  expect(await connect(7, P2)).toEqual({ total: 3, returning: false });
  expect(await disconnect(7, P1)).toBe(2);
  expect(await connectionCount(7)).toBe(2);
});

test('last socket gone: online during the pause, then offline; coming back in the pause is "returning"', async () => {
  await connect(7, P1);
  expect(await disconnect(7, P1)).toBe(0);
  expect(await onlineUsers([7, 8])).toEqual(new Set([7]));      // пауза: перезагрузка вкладки — не уход
  expect(await connectionCount(7)).toBe(0);
  expect(await connect(7, P2)).toEqual({ total: 1, returning: true });
  await disconnect(7, P2);
  await Bun.sleep(700);                                           // ключ паузы — вдвое дольше неё (страховка без таймера)
  expect(await onlineUsers([7])).toEqual(new Set());
});

test('only the latest pause may announce leaving; afterwards a new socket is not "returning"', async () => {
  await connect(7, P1);
  await disconnect(7, P1, 'early');
  await connect(7, P2);                                          // перезагрузка на другой процесс
  await disconnect(7, P2, 'late');
  expect(await leave(7, 'early')).toBe(false);                   // таймер давней паузы — не его дело
  expect(await onlineUsers([7])).toEqual(new Set([7]));
  expect(await leave(7, 'late')).toBe(true);
  expect(await onlineUsers([7])).toEqual(new Set());
  expect(await connect(7, P1)).toEqual({ total: 1, returning: false });
  await disconnect(7, P1, 'again');
  await connect(7, P2);
  expect(await leave(7, 'again')).toBe(false);                   // вернулся за паузу
});

test('a dead process does not count, and its stale counts are dropped', async () => {
  await connect(7, P1);
  await processGone(P1);
  expect(await connectionCount(7)).toBe(0);
  expect(await onlineUsers([7])).toEqual(new Set());
  await processAlive(P1);                                        // тот же id снова жив — старый счётчик уже стёрт
  expect(await connect(7, P2)).toEqual({ total: 1, returning: false });
});
