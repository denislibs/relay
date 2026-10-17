import type { Engine, WatchHandle } from './engine';
import type { Action, EngineConfig, Patch, Query } from './types';

/** Сообщения от вкладки к хосту. */
export type ToHost =
  | { t: 'hello'; build: string; config: EngineConfig }
  | { t: 'watch' | 'update'; sub: number; query: Query }
  | { t: 'unwatch'; sub: number }
  | { t: 'call'; id: number; action: Action }
  | { t: 'ping' }
  | { t: 'bye' };

/** Сообщения от хоста к вкладке. */
export type FromHost =
  | { t: 'ready' }
  | { t: 'patches'; items: { sub: number; patch: Patch }[] }
  | { t: 'result'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'reload' }
  | { t: 'pong' };

export interface PortLike<In, Out> {
  post(m: Out): void;
  listen(cb: (m: In) => void): void;
}

export function fromMessagePort<In, Out>(port: { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null }): PortLike<In, Out> {
  return {
    post: (m) => port.postMessage(m),
    listen: (cb) => { port.onmessage = (e) => cb(e.data as In); },
  };
}

interface Client {
  port: PortLike<ToHost, FromHost>;
  subs: Map<number, WatchHandle>;
  buf: { sub: number; patch: Patch }[];
  queued: boolean;
  lastSeen: number;
}

/**
 * Один движок — много вкладок. Каждая вкладка получает патчи только своих подписок,
 * пачкой на микрозадачу (движок уже батчит их раз в кадр).
 */
export class HostCore {
  private engine: Promise<Engine> | null = null;
  private clients = new Set<Client>();

  constructor(private opts: { build: string; open: (cfg: EngineConfig) => Promise<Engine> }) {}

  get size(): number { return this.clients.size; }

  attach(port: PortLike<ToHost, FromHost>): { detach(): void } {
    const c: Client = { port, subs: new Map(), buf: [], queued: false, lastSeen: Date.now() };
    this.clients.add(c);
    port.listen((m) => { this.onMessage(c, m).catch((err) => console.error('host:', err)); });
    return { detach: () => this.detach(c) };
  }

  /** Вкладки без пульса дольше maxIdleMs считаются закрытыми. */
  sweep(maxIdleMs: number, now = Date.now()): void {
    for (const c of [...this.clients]) if (now - c.lastSeen > maxIdleMs) this.detach(c);
  }

  async close(): Promise<void> {
    for (const c of [...this.clients]) this.detach(c);
    if (this.engine) await (await this.engine).close();
    this.engine = null;
  }

  private async onMessage(c: Client, m: ToHost): Promise<void> {
    c.lastSeen = Date.now();
    switch (m.t) {
      case 'hello': {
        if (m.build !== this.opts.build) { c.port.post({ t: 'reload' }); return; }
        this.engine ??= this.opts.open(m.config).then((e) => {
          e.onObsolete(() => this.obsolete());
          // сеанс завершён: движок стёр данные и закрылся; следующий вход (hello после входа) откроет новый
          const opened = this.engine;
          e.onTerminated(() => { if (this.engine === opened) this.engine = null; });
          e.connect();
          return e;
        });
        await this.engine;
        c.port.post({ t: 'ready' });
        return;
      }
      case 'ping': c.port.post({ t: 'pong' }); return;
      case 'bye': this.detach(c); return;
    }
    if (!this.engine) return; // до hello вкладка ничего не просит
    const engine = await this.engine;
    if (!this.clients.has(c)) return;
    switch (m.t) {
      case 'watch': {
        c.subs.get(m.sub)?.close();
        c.subs.set(m.sub, engine.watch(m.query, (patch) => this.queue(c, m.sub, patch)));
        return;
      }
      case 'update': c.subs.get(m.sub)?.update(m.query); return;
      case 'unwatch': c.subs.get(m.sub)?.close(); c.subs.delete(m.sub); return;
      case 'call': {
        try {
          const value = await engine.call(m.action);
          c.port.post({ t: 'result', id: m.id, ok: true, value });
        } catch (err) {
          c.port.post({ t: 'result', id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
        }
        return;
      }
    }
  }

  /** Движок устарел (новая сборка обновляет базу): все вкладки перезагружаются на новую сборку. */
  private obsolete(): void {
    this.engine = null;
    for (const c of this.clients) c.port.post({ t: 'reload' });
  }

  private queue(c: Client, sub: number, patch: Patch): void {
    c.buf.push({ sub, patch });
    if (c.queued) return;
    c.queued = true;
    queueMicrotask(() => {
      c.queued = false;
      const items = c.buf;
      c.buf = [];
      if (this.clients.has(c) && items.length) c.port.post({ t: 'patches', items });
    });
  }

  private detach(c: Client): void {
    for (const s of c.subs.values()) s.close();
    c.subs.clear();
    this.clients.delete(c);
  }
}
