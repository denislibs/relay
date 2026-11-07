// Судья фазы наблюдения после выката (docs/deploy.md, «Наблюдение после выката»; спецификация —
// docs/superpowers/specs/2026-11-07-deploy-bake-design.md). Запускает deploy.sh одноразовым контейнером из образа server
// в сети стека:
//   bun /bake.ts --build <sha> [--base <прежний sha>] --minutes 10 [--interval 30] [--strict]
// Раз в interval: /ready сервера и метрики новой сборки из VictoriaMetrics против прежней сборки за час до выката.
// Вывод — публичный лог GitHub Actions: только названия сигналов и числа. Код выхода: 0 — ок, 1 — откатить, 2 — аргументы.

export interface Sample {
  seen: boolean;                       // VictoriaMetrics видит новую сборку (relay_build_info)
  reqs: number; err5xx: number; wsInternal: number; clientErrors: number;
  p95: number | null;                  // секунды; null — запросов не было
  up: Record<string, number>;          // job → min(up): server, worker
  uptime: Record<string, number>;      // job → min(relay_process_uptime_seconds) новой сборки
}
export type Base = Pick<Sample, 'reqs' | 'err5xx' | 'wsInternal' | 'clientErrors' | 'p95'>;
export const ZERO_BASE: Base = { reqs: 0, err5xx: 0, wsInternal: 0, clientErrors: 0, p95: null };

/** Счётчики подряд идущих плохих замеров (сигналы «2 замера подряд»). */
export interface Streak { ready: number; up: number }

export interface Verdict { verdict: 'ok' | 'wait' | 'fail'; reasons: string[] }

export const LIMITS = {
  minReqs5xx: 20, ratio5xx: 0.02, factor5xx: 3,
  wsFactor: 3, wsSlack: 5,
  clientFactor: 3, clientSlack: 5,
  minReqsP95: 50, p95Floor: 1, p95Factor: 2,
  streak: 2,
};
// --strict (только руками): пороги нулевые — любой запрос новой сборки даёт «откатить»; проверка, что запросы к
// живой VictoriaMetrics возвращают данные. deploy.sh его не передаёт.
export const STRICT = { ...LIMITS, minReqs5xx: 1, ratio5xx: -1, factor5xx: 0 };

/**
 * Один замер → вердикт. sample = null — VictoriaMetrics недоступна: метрические сигналы пропускаются (поломка
 * мониторинга — не повод откатывать), /ready проверяется всё равно. elapsed и bake — секунды.
 */
export function judge(ready: boolean | null, sample: Sample | null, base: Base, streak: Streak, elapsed: number, bake: number, interval: number, L = LIMITS): Verdict {
  const reasons: string[] = [];
  streak.ready = ready === false ? streak.ready + 1 : 0;
  if (streak.ready >= L.streak) reasons.push(`ready: /ready is false ${streak.ready} times in a row`);

  if (sample) {
    const down = ['server', 'worker'].filter((j) => sample.up[j] === 0);
    streak.up = down.length ? streak.up + 1 : 0;
    if (streak.up >= L.streak) reasons.push(`up: ${down.join(',')} not scraped ${streak.up} times in a row`);
    // процесс новой сборки работает меньше, чем идёт наблюдение (с запасом на шаг опроса) — перезапускался
    for (const [job, up] of Object.entries(sample.uptime)) {
      if (up + interval * 2 < elapsed) reasons.push(`restart: ${job} up for ${Math.round(up)}s, bake running ${Math.round(elapsed)}s`);
    }
    const ratio = sample.reqs ? sample.err5xx / sample.reqs : 0;
    const baseRatio = base.reqs ? base.err5xx / base.reqs : 0;
    const strictHit = L.ratio5xx < 0 && sample.reqs >= L.minReqs5xx;
    if (strictHit || (sample.reqs >= L.minReqs5xx && ratio > L.ratio5xx && ratio > L.factor5xx * baseRatio)) {
      reasons.push(`5xx: ${pct(ratio)} of ${sample.reqs} requests (base ${pct(baseRatio)})`);
    }
    if (sample.wsInternal > L.wsFactor * base.wsInternal + L.wsSlack) reasons.push(`ws internal errors: ${n(sample.wsInternal)} (base ${n(base.wsInternal)})`);
    if (sample.clientErrors > L.clientFactor * base.clientErrors + L.clientSlack) reasons.push(`client errors: ${n(sample.clientErrors)} (base ${n(base.clientErrors)})`);
    if (sample.p95 != null && sample.reqs >= L.minReqsP95 && sample.p95 > L.p95Floor && sample.p95 > L.p95Factor * (base.p95 ?? 0)) {
      reasons.push(`p95: ${sample.p95.toFixed(2)}s (base ${base.p95 == null ? 'none' : base.p95.toFixed(2) + 's'})`);
    }
    if (!sample.seen && elapsed >= bake / 2) reasons.push('metrics: VictoriaMetrics does not see the new build');
  }
  if (reasons.length) return { verdict: 'fail', reasons };
  if (sample && !sample.seen) return { verdict: 'wait', reasons: [] };
  return { verdict: elapsed >= bake ? 'ok' : 'wait', reasons: [] };
}

const pct = (x: number) => (x * 100).toFixed(1) + '%';
const n = (x: number) => String(Math.round(x * 10) / 10);

// --- VictoriaMetrics -------------------------------------------------------------------------------------------------

type VmVector = { status: string; data?: { resultType: string; result: { metric: Record<string, string>; value: [number, string] }[] } };

/** Ответ /api/v1/query → { значение метки by (или ''): число }; NaN и пустые ряды пропускаются. */
export function parseVector(body: VmVector, by = ''): Record<string, number> {
  if (body.status !== 'success' || body.data?.resultType !== 'vector') throw new Error('bad VictoriaMetrics response');
  const out: Record<string, number> = {};
  for (const r of body.data.result) {
    const v = Number(r.value[1]);
    if (Number.isFinite(v)) out[by ? r.metric[by] ?? '' : ''] = v;
  }
  return out;
}

const sel = (build: string) => `build="${build.replace(/[^\w.-]/g, '')}"`;

/** PromQL замера: окно — секунды наблюдения (новая сборка) или час до выката (база). */
export function queries(build: string, window: number) {
  const b = sel(build), w = `[${Math.max(60, Math.round(window))}s]`;
  return {
    seen: `count(relay_build_info{${b}})`,
    reqs: `sum(increase(relay_http_requests_total{${b}}${w}))`,
    err5xx: `sum(increase(relay_http_requests_total{${b},status=~"5.."}${w}))`,
    wsInternal: `sum(increase(relay_ws_frames_total{${b},result="internal"}${w}))`,
    clientErrors: `sum(increase(relay_client_errors_total{client_build="${build.replace(/[^\w.-]/g, '')}"}${w}))`,
    p95: `histogram_quantile(0.95, sum by (le) (increase(relay_http_request_duration_seconds_bucket{${b}}${w})))`,
    up: 'min by (job) (up{job=~"server|worker"})',
    uptime: `min by (job) (relay_process_uptime_seconds{${b},job=~"server|worker"})`,
  };
}

async function vm(url: string, q: string, time?: number): Promise<VmVector> {
  const qs = new URLSearchParams({ query: q, ...(time ? { time: String(time) } : {}) });
  const r = await fetch(`${url}/api/v1/query?${qs}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`VictoriaMetrics ${r.status}`);
  return r.json() as Promise<VmVector>;
}

async function sample(url: string, build: string, window: number): Promise<Sample> {
  const q = queries(build, window);
  const one = async (k: keyof typeof q) => parseVector(await vm(url, q[k]))[''] ?? 0;
  const p95 = parseVector(await vm(url, q.p95))[''];
  return {
    seen: (await one('seen')) > 0, reqs: await one('reqs'), err5xx: await one('err5xx'),
    wsInternal: await one('wsInternal'), clientErrors: await one('clientErrors'), p95: p95 ?? null,
    up: parseVector(await vm(url, q.up), 'job'), uptime: parseVector(await vm(url, q.uptime), 'job'),
  };
}

/** База: прежняя сборка за час до начала выката, приведённая к окну наблюдения. */
async function baseline(url: string, build: string, at: number, window: number): Promise<Base> {
  if (!build) return ZERO_BASE;
  const q = queries(build, 3600), k = window / 3600;
  const one = async (key: keyof typeof q) => (parseVector(await vm(url, q[key], at))[''] ?? 0) * k;
  const p95 = parseVector(await vm(url, q.p95, at))[''];
  return { reqs: await one('reqs'), err5xx: await one('err5xx'), wsInternal: await one('wsInternal'), clientErrors: await one('clientErrors'), p95: p95 ?? null };
}

async function readyOk(url: string): Promise<boolean | null> {
  try { const r = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(5000) }); return r.ok && (await r.json() as { ok?: boolean }).ok === true; }
  catch { return false; }
}

export function args(argv: string[]): { build: string; base: string; minutes: number; interval: number; strict: boolean } | null {
  const a = new Map<string, string>(); let strict = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--strict') { strict = true; continue; }
    if (!argv[i]!.startsWith('--') || argv[i + 1] == null) return null;
    a.set(argv[i]!.slice(2), argv[++i]!);
  }
  const build = a.get('build') ?? '', base = a.get('base') ?? '', minutes = Number(a.get('minutes') ?? 10), interval = Number(a.get('interval') ?? 30);
  if (!/^[0-9a-f]{7,64}$/.test(build) || (base && !/^[0-9a-f]{7,64}$/.test(base)) || !(minutes > 0) || !(interval >= 5)) return null;
  return { build, base, minutes, interval, strict };
}

async function main(): Promise<number> {
  const o = args(process.argv.slice(2));
  if (!o) { console.error('usage: bake.ts --build <sha> [--base <sha>] --minutes N [--interval S] [--strict]'); return 2; }
  const VM = process.env.BAKE_VM_URL ?? 'http://victoriametrics:8428', API = process.env.BAKE_API_URL ?? 'http://server:3000';
  const L = o.strict ? STRICT : LIMITS, bake = o.minutes * 60, start = Date.now() / 1000, streak: Streak = { ready: 0, up: 0 };
  let base: Base | null = null, warned = false;
  const log = (s: string) => console.error(`bake +${Math.round(Date.now() / 1000 - start)}s ${s}`);
  for (;;) {
    await Bun.sleep(o.interval * 1000);
    const elapsed = Date.now() / 1000 - start;
    const ready = await readyOk(API);
    let s: Sample | null = null;
    try {
      base ??= await baseline(VM, o.base, Math.floor(start), bake);
      s = await sample(VM, o.build, elapsed);
    } catch (e) {
      if (!warned) log(`warning: VictoriaMetrics unavailable (${(e as Error).message}) — checking /ready only`);
      warned = true;
    }
    const v = judge(ready, s, base ?? ZERO_BASE, streak, elapsed, bake, o.interval, L);
    log(`${v.verdict} ready=${ready}` + (s ? ` reqs=${n(s.reqs)} 5xx=${n(s.err5xx)} ws_internal=${n(s.wsInternal)} client_errors=${n(s.clientErrors)} p95=${s.p95 == null ? '-' : s.p95.toFixed(2)}` : ''));
    if (v.verdict === 'fail') { for (const r of v.reasons) log(`FAIL ${r}`); console.log(JSON.stringify({ verdict: 'fail', reasons: v.reasons })); return 1; }
    if (v.verdict === 'ok') { console.log(JSON.stringify({ verdict: 'ok', reasons: [] })); return 0; }
  }
}

if (import.meta.main) process.exit(await main());
