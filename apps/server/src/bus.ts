import type { RedisClient } from 'bun';
import { key, valkey } from './valkey';

/**
 * Кадры мимо журнала («печатает…», присутствие, изменения контактов) — между процессами через pub/sub Valkey.
 * Процесс подписан на топики своих сокетов (счётчик ссылок: подписка — с первым сокетом, отписка — с последним)
 * и раздаёт пришедшее локально через deliver (server.publish). Свои публикации приходят так же — отдельной
 * локальной доставки нет, иначе кадр пришёл бы дважды. Доставка «как получится»: это не данные.
 */
export interface Bus {
  publish(topic: string, msg: string): void;
  listen(topic: string): Promise<void>;
  unlisten(topic: string): Promise<void>;
  close(): Promise<void>;
}

export function createBus(deliver: (topic: string, msg: string) => void): Bus {
  const refs = new Map<string, number>();
  let sub: Promise<RedisClient> | null = null;
  // подписка занимает соединение целиком — отдельное от команд
  const subscriber = () => (sub ??= (async () => { await valkey().connect(); return valkey().duplicate(); })());
  const channel = (topic: string) => key('t:' + topic);
  return {
    publish(topic, msg) {
      valkey().publish(channel(topic), msg).catch((e) => console.error('bus publish:', e));
    },
    async listen(topic) {
      const n = (refs.get(topic) ?? 0) + 1;
      refs.set(topic, n);
      if (n === 1) await (await subscriber()).subscribe(channel(topic), (msg: string) => deliver(topic, msg));
    },
    async unlisten(topic) {
      const n = (refs.get(topic) ?? 0) - 1;
      if (n > 0) { refs.set(topic, n); return; }
      refs.delete(topic);
      // команды идут по одному соединению по порядку: быстрые «отписка → подписка» не перепутаются
      await (await subscriber()).unsubscribe(channel(topic));
    },
    async close() {
      if (sub) (await sub).close();
      sub = null;
      refs.clear();
    },
  };
}
