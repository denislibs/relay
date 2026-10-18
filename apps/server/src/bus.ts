import type { RedisClient } from 'bun';
import { key, valkey } from './valkey';

/**
 * Кадры мимо журнала («печатает…», присутствие, изменения контактов) — между процессами через pub/sub Valkey.
 * Процесс подписан на топики своих сокетов (счётчик ссылок: подписка — с первым сокетом, отписка — с последним)
 * и раздаёт пришедшее локально через deliver (server.publish). Свои публикации приходят так же — отдельной
 * локальной доставки нет, иначе кадр пришёл бы дважды. Доставка «как получится»: это не данные.
 *
 * Подписка занимает соединение целиком — отдельное от команд. Переподключившись, Bun подписки не восстанавливает,
 * а после ~10 с без Valkey закрывает соединение насовсем: в обоих случаях заводим новое и подписываемся заново
 * на все топики (при неудаче — повтор через RETRY_MS).
 */
export interface Bus {
  publish(topic: string, msg: string): void;
  listen(topic: string): Promise<void>;
  unlisten(topic: string): Promise<void>;
  close(): Promise<void>;
}

const RETRY_MS = 2000;
type Conn = { client: Promise<RedisClient>; topics: Set<string> };

export function createBus(deliver: (topic: string, msg: string) => void): Bus {
  const refs = new Map<string, number>();
  let conn: Conn | null = null;
  let stopped = false;
  const channel = (topic: string) => key('t:' + topic);

  function open(): Conn {
    const c: Conn = {
      topics: new Set(),
      client: (async () => {
        await valkey().connect();
        const client = await valkey().duplicate();
        client.onconnect = () => { if (drop(c)) restore(); };   // переподключился, но уже без подписок
        client.onclose = () => { if (drop(c)) restore(); };     // сдался — нужно новое соединение
        return client;
      })(),
    };
    c.client.catch(() => {});   // ошибку увидит тот, кто ждёт подписку
    return c;
  }

  /** Соединение c больше не текущее — закрыть (его обработчики после этого ничего не делают). false — его уже сменили. */
  function drop(c: Conn): boolean {
    if (conn !== c) return false;
    conn = null;
    // обработчики не обнулять: в Bun 1.4.2 присваивание onclose = null ломает и client.close
    void c.client.then((client) => client.close()).catch(() => {});
    return true;
  }

  function restore(): void {
    if (stopped || !refs.size) return;
    Promise.all([...refs.keys()].map(subscribe)).catch((e) => console.error('bus:', e));
  }

  async function subscribe(topic: string): Promise<void> {
    const c = (conn ??= open());
    if (c.topics.has(topic)) return;
    c.topics.add(topic);
    try {
      await (await c.client).subscribe(channel(topic), (msg: string) => deliver(topic, msg));
    } catch (e) {
      if (drop(c)) setTimeout(restore, RETRY_MS).unref?.();
      throw e;
    }
  }

  return {
    publish(topic, msg) {
      valkey().publish(channel(topic), msg).catch((e) => console.error('bus publish:', e));
    },
    async listen(topic) {
      const n = (refs.get(topic) ?? 0) + 1;
      refs.set(topic, n);
      if (n === 1) await subscribe(topic);
    },
    async unlisten(topic) {
      const n = (refs.get(topic) ?? 0) - 1;
      if (n > 0) { refs.set(topic, n); return; }
      refs.delete(topic);
      const c = conn;
      if (!c?.topics.delete(topic)) return;
      // команды идут по одному соединению по порядку: быстрые «отписка → подписка» не перепутаются
      await (await c.client).unsubscribe(channel(topic));
    },
    async close() {
      stopped = true;
      if (conn) drop(conn);
      refs.clear();
    },
  };
}
