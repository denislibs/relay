import { RedisClient } from 'bun';
import { valkeyTls } from './tls';

/**
 * Valkey — только эфемерное состояние (онлайн, «печатает…», рассылка кадров между процессами).
 * Всё, что должно пережить перезапуск, — в Postgres. Ключи и каналы с префиксом: тесты и dev-стек
 * на одном Valkey друг друга не видят.
 */
let client: RedisClient | null = null;

export function valkey(): RedisClient {
  if (!client) {
    const url = process.env.VALKEY_URL;
    if (!url) throw new Error('VALKEY_URL is not set');
    const tls = valkeyTls();   // rediss:// и свой CA (tls.ts)
    const c = tls === undefined ? new RedisClient(url) : new RedisClient(url, { tls });
    // Bun переподключается сам, но после ~10 с без Valkey закрывает клиент насовсем — следующий вызов заведёт новый
    c.onclose = () => { if (client === c) client = null; };
    client = c;
  }
  return client;
}

export const PREFIX = (process.env.RELAY_BUS_PREFIX ?? 'relay') + ':';
export const key = (k: string): string => PREFIX + k;

/** Тесты: удалить свои ключи (по префиксу), чужие не трогать. */
export async function flushOwn(): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = (await valkey().send('SCAN', [cursor, 'MATCH', PREFIX + '*', 'COUNT', '500'])) as [string, string[]];
    cursor = next;
    if (keys.length) await valkey().send('DEL', keys);
  } while (cursor !== '0');
}

/**
 * Счётчик в окне: n-е обращение за windowSec секунд (окна по часам, ключ живёт два окна). Valkey недоступен — 0
 * (лимит не мешает работе; защита от злоупотреблений — не повод отказывать всем).
 */
export async function hit(name: string, windowSec: number): Promise<number> {
  try {
    const k = key(`rate:${name}:${Math.floor(Date.now() / 1000 / windowSec)}`);
    const n = Number(await valkey().incr(k));
    if (n === 1) await valkey().expire(k, windowSec * 2);
    return n;
  } catch { return 0; }
}
