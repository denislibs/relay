import type { Engine } from '../engine';
import { HostCore, type FromHost, type PortLike, type ToHost } from '../host-core';
import type { EngineConfig } from '../types';

export interface LocksLike { request(name: string, cb: () => Promise<void>): Promise<unknown> }
export interface ChannelLike {
  postMessage(m: unknown): void;
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
  close(): void;
}

type Wire =
  | { to: 'leader'; from: string; msg: ToHost }
  | { to: string; msg: FromHost }
  | { t: 'leader' };

/**
 * Запасной хост, когда SharedWorker недоступен: Dedicated Worker в каждой вкладке.
 * Лидер (Web Locks) держит движок; остальные вкладки проксируют свои сообщения через BroadcastChannel.
 * Когда лидер уходит, следующая вкладка забирает блокировку, а все вкладки переподписываются.
 */
export function createDedicatedHost(opts: {
  self: PortLike<ToHost, FromHost>;
  channel: ChannelLike;
  locks: LocksLike;
  tabId: string;
  build: string;
  open: (cfg: EngineConfig) => Promise<Engine>;
}) {
  let role: 'follower' | 'leader' = 'follower';
  let core: HostCore | null = null;
  let feedLocal: ((m: ToHost) => void) | null = null;
  const remote = new Map<string, (m: ToHost) => void>();
  let release: () => void = () => {};
  let closed = false;

  // состояние своей вкладки — чтобы переподписаться у нового лидера
  let hello: ToHost | null = null;
  const subs = new Map<number, ToHost>();
  const calls = new Set<number>();

  function record(m: ToHost) {
    if (m.t === 'hello') hello = m;
    else if (m.t === 'watch' || m.t === 'update') subs.set(m.sub, { t: 'watch', sub: m.sub, query: m.query });
    else if (m.t === 'unwatch') subs.delete(m.sub);
    else if (m.t === 'call') calls.add(m.id);
  }
  const toSelf = (m: FromHost) => { if (m.t === 'result') calls.delete(m.id); opts.self.post(m); };
  const failCalls = () => { for (const id of calls) opts.self.post({ t: 'result', id, ok: false, error: 'leader_changed' }); calls.clear(); };
  const replay = (send: (m: ToHost) => void) => { if (hello) send(hello); for (const m of subs.values()) send(m); };
  const toLeader = (m: ToHost) => opts.channel.postMessage({ to: 'leader', from: opts.tabId, msg: m } satisfies Wire);

  opts.self.listen((m) => {
    record(m);
    if (role === 'leader') feedLocal!(m);
    else toLeader(m);
  });

  opts.channel.addEventListener('message', (e) => {
    const d = e.data as Wire;
    if ('t' in d) {
      if (d.t === 'leader' && role === 'follower') { failCalls(); replay(toLeader); }
      return;
    }
    if (d.to === 'leader') {
      if (role !== 'leader') return;
      const w = d as Extract<Wire, { from: string }>;
      let feed = remote.get(w.from);
      if (!feed) {
        core!.attach({
          post: (m) => opts.channel.postMessage({ to: w.from, msg: m } satisfies Wire),
          listen: (cb) => { feed = cb; },
        });
        remote.set(w.from, feed!);
      }
      feed!(w.msg);
      if (w.msg.t === 'bye') remote.delete(w.from);
      return;
    }
    if (d.to === opts.tabId) toSelf((d as { msg: FromHost }).msg);
  });

  opts.locks.request('relay-leader@' + opts.build, () => new Promise<void>((resolve) => {
    if (closed) { resolve(); return; }
    release = resolve;
    role = 'leader';
    core = new HostCore({ build: opts.build, open: opts.open });
    core.attach({ post: toSelf, listen: (cb) => { feedLocal = cb; } });
    failCalls();             // вызовы, отправленные прежнему лидеру, потеряны
    replay(feedLocal!);      // своя вкладка — в собственный движок
    opts.channel.postMessage({ t: 'leader' } satisfies Wire);
  }));

  return {
    get role() { return role; },
    async close(): Promise<void> {
      closed = true;
      if (role === 'leader') await core!.close();
      else toLeader({ t: 'bye' });
      release();
      opts.channel.close();
    },
  };
}
