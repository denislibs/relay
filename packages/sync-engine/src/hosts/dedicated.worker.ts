/// <reference lib="webworker" />
// Точка входа Dedicated Worker — запасной путь, где нет SharedWorker (Chrome на Android).
import { Engine } from '../engine';
import { fromMessagePort, type FromHost, type ToHost } from '../host-core';
import { createDedicatedHost } from './dedicated';

const scope = self as unknown as { name: string; postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null };
const build = scope.name.split('@')[1] ?? 'dev';

createDedicatedHost({
  self: fromMessagePort<ToHost, FromHost>(scope),
  channel: new BroadcastChannel('relay-host@' + build),
  locks: navigator.locks,
  tabId: crypto.randomUUID(),
  build,
  open: (cfg) => Engine.open(cfg),
});
