import { fromMessagePort, type FromHost, type PortLike, type ToHost } from './host-core';
import type { Action, EngineConfig, Item, Patch, Query } from './types';

/** Главный поток: подписки и действия поверх порта хоста. */
export class EngineClient {
  readonly ready: Promise<void>;
  private subs = new Map<number, (p: Patch) => void>();
  private calls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private nextSub = 1;
  private nextCall = 1;
  private onReloadCb: () => void = () => {};
  private onDataCb: ((v: unknown) => void) | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private markReady!: () => void;

  constructor(private port: PortLike<FromHost, ToHost>, build: string, config: EngineConfig, opts: { pingMs?: number } = {}) {
    this.ready = new Promise((r) => { this.markReady = r; });
    port.listen((m) => this.onMessage(m));
    port.post({ t: 'hello', build, config });
    this.ping = setInterval(() => port.post({ t: 'ping' }), opts.pingMs ?? 10_000);
  }

  watch(query: Query, onPatch: (p: Patch) => void): { update(q: Query): void; close(): void } {
    const sub = this.nextSub++;
    this.subs.set(sub, onPatch);
    this.port.post({ t: 'watch', sub, query });
    return {
      update: (q) => this.port.post({ t: 'update', sub, query: q }),
      close: () => { this.subs.delete(sub); this.port.post({ t: 'unwatch', sub }); },
    };
  }

  call<T = unknown>(action: Action): Promise<T> {
    const id = this.nextCall++;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.post({ t: 'call', id, action });
    });
  }

  onReload(cb: () => void): void { this.onReloadCb = cb; }
  /** Всё, что приходит от движка (патчи и ответы), — приложению до подписчиков (например, запомнить ключи файлов). */
  onData(cb: (v: unknown) => void): void { this.onDataCb = cb; }

  close(): void {
    if (this.ping) clearInterval(this.ping);
    this.port.post({ t: 'bye' });
  }

  private onMessage(m: FromHost): void {
    switch (m.t) {
      case 'ready': this.markReady(); return;
      case 'patches': for (const { sub, patch } of m.items) { this.onDataCb?.(patch); this.subs.get(sub)?.(patch); } return;
      case 'result': {
        const c = this.calls.get(m.id);
        if (!c) return;
        this.calls.delete(m.id);
        if (m.ok) this.onDataCb?.(m.value);
        if (m.ok) c.resolve(m.value); else c.reject(new Error(m.error));
        return;
      }
      case 'reload': this.onReloadCb(); return;
      case 'pong': return;
    }
  }
}

/** Зеркало результата подписки: применяет snapshot/diff и отдаёт список в нужном порядке. */
export class Mirror {
  items = new Map<string, Item>();
  order: string[] = [];
  apply(p: Patch): void {
    if (p.op === 'snapshot') {
      this.items = new Map(p.items.map((i) => [i.key, i]));
      this.order = p.order;
      return;
    }
    for (const k of p.remove) this.items.delete(k);
    for (const i of p.upsert) this.items.set(i.key, i);
    if (p.order) this.order = p.order;
    else if (p.append) {   // журнал: убранные — старейшие, новые — в конец
      const order = p.remove.length ? this.order.slice(p.remove.length) : this.order.slice();
      for (const i of p.upsert) order.push(i.key);
      this.order = order;
    }
  }
  /** Данные без служебных элементов (ключи на «~», например ~window — края окна ленты). */
  list(): Item[] { return this.order.map((k) => this.items.get(k)!).filter((i) => i && !i.key.startsWith('~')); }
  meta(key: string): Item | undefined { return this.items.get(key); }
}

/** SharedWorker, если он есть; иначе Dedicated Worker с выбором лидера. */
export function connectEngine(opts: { build: string; config: EngineConfig; sharedUrl: URL | string; dedicatedUrl: URL | string }): EngineClient {
  const name = 'relay@' + opts.build;
  const dedicated = () => fromMessagePort<FromHost, ToHost>(new Worker(opts.dedicatedUrl, { type: 'module', name }) as unknown as MessagePort);
  if (typeof SharedWorker === 'function') {
    try {
      const w = new SharedWorker(opts.sharedUrl, { type: 'module', name });
      w.port.start();
      const shared = fromMessagePort<FromHost, ToHost>(w.port);
      return new EngineClient(fallbackPort(shared, (fail) => w.addEventListener('error', fail), dedicated), opts.build, opts.config);
    } catch { /* приватный режим и т. п. — запасной путь */ }
  }
  return new EngineClient(dedicated(), opts.build, opts.config);
}

/**
 * SharedWorker может не загрузиться уже после конструктора: скрипт не получен (самоподписанный сертификат,
 * встроенный браузер, блокировка). Исключения тогда нет — только событие error, и без запасного пути
 * приложение вечно ждёт ответа. Поэтому до первого 'ready' запоминаем отправленное (кроме ping);
 * сбой — переходим на запасной порт и повторяем записанное в том же порядке. После 'ready' сбои не наши.
 */
export function fallbackPort(
  primary: PortLike<FromHost, ToHost>,
  onFail: (fail: () => void) => void,
  secondary: () => PortLike<FromHost, ToHost>,
): PortLike<FromHost, ToHost> {
  let port = primary;
  let log: ToHost[] | null = [];
  let cb: ((m: FromHost) => void) | null = null;
  const attach = (p: PortLike<FromHost, ToHost>) => p.listen((m) => {
    if (p !== port) return;               // брошенный порт молчит
    if (m.t === 'ready') log = null;
    cb?.(m);
  });
  attach(primary);
  onFail(() => {
    if (!log) return;
    const replay = log;
    log = [];
    port = secondary();
    attach(port);
    for (const m of replay) port.post(m);
  });
  return {
    post: (m) => { if (log && m.t !== 'ping') log.push(m); port.post(m); },
    listen: (fn) => { cb = fn; },
  };
}
