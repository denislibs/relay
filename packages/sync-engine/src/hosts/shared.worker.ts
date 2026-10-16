/// <reference lib="webworker" />
// Точка входа SharedWorker: один движок на все вкладки origin.
import { Engine } from '../engine';
import { fromMessagePort, HostCore, type FromHost, type ToHost } from '../host-core';

const scope = self as unknown as { name: string; onconnect: ((e: MessageEvent) => void) | null };
const build = scope.name.split('@')[1] ?? 'dev';
const core = new HostCore({ build, open: (cfg) => Engine.open(cfg) });

scope.onconnect = (e) => { core.attach(fromMessagePort<ToHost, FromHost>(e.ports[0])); };
// вкладки шлют ping раз в 10 с; молчащие 30 с считаются закрытыми (у MessagePort нет события close)
setInterval(() => core.sweep(30_000), 10_000);
