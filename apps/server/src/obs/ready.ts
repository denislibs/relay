import { sql } from '../db';
import { valkey } from '../valkey';
import { getKms } from '../crypto/kms';
import { dependencyUp } from './appMetrics';
import { onCollect } from './metrics';

/**
 * Готовность (/ready): процесс жив (/health) и может работать — Postgres и Valkey отвечают, KMS готов (сервис
 * ключей отвечает, Vault/OpenBao не запечатан). Ответ кэшируется на CACHE_MS: /ready доступен снаружи через
 * nginx, частый опрос не должен превращаться в нагрузку на базу.
 */
export type Dep = 'postgres' | 'valkey' | 'kms';
export interface Readiness { ok: boolean; checks: Record<Dep, boolean> }

const CACHE_MS = 2000;
const TIMEOUT_MS = 3000;

const within = <T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** Проверки зависимостей; тесты подменяют отдельные (например, «Valkey недоступен»). */
export const checks: Record<Dep, () => Promise<boolean>> = {
  postgres: async () => (await sql`select 1 as ok`)[0]?.ok === 1,
  valkey: async () => String(await valkey().send('PING', [])) === 'PONG',
  kms: async () => { const k = getKms(); return k.ready ? await k.ready() : true; },
};

let cached: { at: number; value: Promise<Readiness> } | null = null;

export function readiness(now = Date.now()): Promise<Readiness> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = (async () => {
    const deps = Object.keys(checks) as Dep[];
    const res = await Promise.all(deps.map((d) => within(Promise.resolve().then(checks[d])).then((ok) => ok === true, () => false)));
    const out = Object.fromEntries(deps.map((d, i) => [d, res[i]])) as Record<Dep, boolean>;
    for (const d of deps) dependencyUp.set({ dep: d }, out[d] ? 1 : 0);
    return { ok: res.every(Boolean), checks: out };
  })();
  cached = { at: now, value };
  return value;
}

/** Тесты: сбросить кэш после подмены проверки. */
export function resetReadinessCache(): void { cached = null; }

export async function readyResponse(): Promise<Response> {
  const r = await readiness();
  return Response.json(r, { status: r.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}

// relay_dependency_up — при каждом опросе метрик (не ждать, пока кто-то спросит /ready)
onCollect(async () => { await readiness(); });
