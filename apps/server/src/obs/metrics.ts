import { readFileSync } from 'node:fs';

/**
 * Метрики процесса в текстовом формате Prometheus (docs/observability.md). Без зависимостей: счётчики, «датчики»
 * и гистограммы с метками; у каждой серии — метка build (BUILD_ID сборки): канарейка сравнивает сборки по ним.
 * Отдаются только на внутреннем порту (obs/server.ts) — nginx их не видит.
 *
 * Метки — только из ограниченных наборов (группа маршрута, op кадра, код ошибки, kind задачи): id пользователей,
 * чатов и адреса в метки не попадают, иначе число серий растёт без предела.
 */
export const BUILD_ID = (process.env.BUILD_ID || buildFile() || 'dev').replace(/[^\w.-]/g, '').slice(0, 64) || 'dev';

/** id сборки, записанный в образ (apps/server/Dockerfile): тот же, что у клиента этого образа. */
function buildFile(): string {
  try { return readFileSync(process.env.BUILD_ID_FILE ?? '/app/BUILD_ID', 'utf8').trim(); } catch { return ''; }
}

type Labels = Record<string, string | number>;
interface Metric { name: string; help: string; type: 'counter' | 'gauge' | 'histogram'; render(out: string[]): void | Promise<void> }

const registry = new Map<string, Metric>();
/** Датчики, которые считаются при каждом опросе (глубина очереди, готовность зависимостей). */
const collectors: (() => Promise<void> | void)[] = [];

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labelKey = (l: Labels) => Object.keys(l).sort().map((k) => `${k}=${String(l[k])}`).join('\u0001');
function labelText(l: Labels, extra?: [string, string]): string {
  const parts = [`build="${esc(BUILD_ID)}"`];
  for (const k of Object.keys(l).sort()) parts.push(`${k}="${esc(String(l[k]))}"`);
  if (extra) parts.push(`${extra[0]}="${esc(extra[1])}"`);
  return `{${parts.join(',')}}`;
}
const num = (n: number) => (Number.isFinite(n) ? String(n) : n > 0 ? '+Inf' : n < 0 ? '-Inf' : 'NaN');

function register<M extends Metric>(m: M): M {
  const old = registry.get(m.name);
  if (old) return old as M;   // повторный импорт модуля (тесты) — та же метрика
  registry.set(m.name, m);
  return m;
}

export interface Counter { inc(labels?: Labels, by?: number): void; get(labels?: Labels): number }
export function counter(name: string, help: string): Counter {
  const values = new Map<string, { l: Labels; v: number }>();
  const m = register({
    name, help, type: 'counter' as const, values,
    render(out: string[]) { for (const { l, v } of values.values()) out.push(`${name}${labelText(l)} ${num(v)}`); },
    inc(l: Labels = {}, by = 1) {
      const k = labelKey(l), cur = values.get(k);
      if (cur) cur.v += by; else values.set(k, { l: { ...l }, v: by });
    },
    get(l: Labels = {}) { return values.get(labelKey(l))?.v ?? 0; },
  });
  return m;
}

export interface Gauge { set(labels: Labels, v: number): void; reset(): void; get(labels?: Labels): number }
export function gauge(name: string, help: string): Gauge {
  const values = new Map<string, { l: Labels; v: number }>();
  return register({
    name, help, type: 'gauge' as const,
    render(out: string[]) { for (const { l, v } of values.values()) out.push(`${name}${labelText(l)} ${num(v)}`); },
    set(l: Labels, v: number) { values.set(labelKey(l), { l: { ...l }, v }); },
    reset() { values.clear(); },
    get(l: Labels = {}) { return values.get(labelKey(l))?.v ?? 0; },
  });
}

export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface Histogram { observe(labels: Labels, seconds: number): void }
export function histogram(name: string, help: string, buckets = LATENCY_BUCKETS): Histogram {
  const values = new Map<string, { l: Labels; counts: number[]; sum: number; n: number }>();
  return register({
    name, help, type: 'histogram' as const,
    render(out: string[]) {
      for (const { l, counts, sum, n } of values.values()) {
        let acc = 0;
        buckets.forEach((b, i) => { acc += counts[i]; out.push(`${name}_bucket${labelText(l, ['le', num(b)])} ${acc}`); });
        out.push(`${name}_bucket${labelText(l, ['le', '+Inf'])} ${n}`);
        out.push(`${name}_sum${labelText(l)} ${num(sum)}`);
        out.push(`${name}_count${labelText(l)} ${n}`);
      }
    },
    observe(l: Labels, s: number) {
      const k = labelKey(l);
      let h = values.get(k);
      if (!h) values.set(k, (h = { l: { ...l }, counts: buckets.map(() => 0), sum: 0, n: 0 }));
      const i = buckets.findIndex((b) => s <= b);
      if (i >= 0) h.counts[i]++;
      h.sum += s; h.n++;
    },
  });
}

/** Значение, которое считается в момент опроса (ошибка сборщика не роняет остальные метрики). */
export function onCollect(fn: () => Promise<void> | void): void { collectors.push(fn); }

/** Текст для /metrics. */
export async function renderMetrics(): Promise<string> {
  await Promise.all(collectors.map((c) => Promise.resolve().then(c).catch((e) => console.warn('metrics collector:', String(e)))));
  const out: string[] = [];
  for (const m of registry.values()) {
    out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`);
    await m.render(out);
  }
  return out.join('\n') + '\n';
}

// ---- общие метрики процесса ----

const processInfo = gauge('relay_build_info', 'Сборка и роль процесса (значение всегда 1)');
const memory = gauge('relay_process_memory_bytes', 'Память процесса: rss, heap_used, heap_total, external');
const uptime = gauge('relay_process_uptime_seconds', 'Сколько секунд работает процесс');
const started = Date.now();
let role = 'server';
/** Роль процесса (server | worker | keys) — метка relay_build_info. */
export function setProcessRole(r: string): void { role = r; }
onCollect(() => {
  processInfo.reset();
  processInfo.set({ proc: role }, 1);
  const m = process.memoryUsage();
  memory.set({ kind: 'rss' }, m.rss);
  memory.set({ kind: 'heap_used' }, m.heapUsed);
  memory.set({ kind: 'heap_total' }, m.heapTotal);
  memory.set({ kind: 'external' }, m.external);
  uptime.set({}, (Date.now() - started) / 1000);
});
