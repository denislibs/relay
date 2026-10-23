import { sql } from '../db';
import { batchHandlers, handlers, PermanentError } from './handlers';
import { claim, complete, completeMany, fail, LEASE_SEC, type Job, type KindFilter } from './queue';

type Done = (job: Job) => Promise<void>;

/**
 * Выполнить одну задачу: успех — complete (или done: групповой коммит цикла), ошибка — fail
 * (PermanentError и неизвестный kind — без повтора). Ошибка самого complete — тоже fail: задача повторится.
 */
export async function runJob(job: Job, done: Done = complete): Promise<void> {
  const h = handlers[job.kind];
  if (!h) { await fail(job, new Error(`no handler for ${job.kind}`), { retry: false }); return; }
  try {
    const res = await h(job.payload, job);
    await (res ? complete(job, res.again) : done(job));
  } catch (e) {
    await fail(job, e, { retry: !(e instanceof PermanentError) });
  }
}

/** Не больше n одновременно: откат пачки по одной не должен разом занять весь пул соединений. */
async function eachLimited<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/**
 * Пачка задач одного kind с обработчиком пачки: успех — все готовы одним delete; ошибка — по одной через
 * обычный обработчик (handlers.ts), чтобы одна плохая задача не держала остальные.
 */
export async function runBatch(jobs: Job[]): Promise<void> {
  const kind = jobs[0].kind;
  try {
    await batchHandlers[kind].run(jobs);
  } catch (e) {
    console.error(`jobs ${kind}: batch of ${jobs.length} failed, running one by one:`, e);
    await eachLimited(jobs, 10, (j) => runJob(j));
    return;
  }
  await completeMany(jobs).catch((e) => Promise.all(jobs.map((j) => fail(j, e))));
}

/**
 * Групповой коммит: задачи, закончившиеся, пока идёт предыдущий delete, уходят следующим одним delete.
 * Промис задачи решается, когда её строка удалена, — слот цикла освобождается только после коммита.
 */
function groupCommit(): Done {
  let pending: { job: Job; ok: () => void; err: (e: unknown) => void }[] = [];
  let flushing = false;
  const flush = async () => {
    flushing = true;
    while (pending.length) {
      const batch = pending;
      pending = [];
      try {
        await completeMany(batch.map((p) => p.job));
        for (const p of batch) p.ok();
      } catch (e) {
        for (const p of batch) p.err(e);
      }
    }
    flushing = false;
  };
  return (job) => new Promise<void>((ok, err) => {
    pending.push({ job, ok, err });
    if (!flushing) void flush();
  });
}

const allowed = (kind: string, f: KindFilter) => (!f.only || f.only.includes(kind)) && !(f.except ?? []).includes(kind);

/** Тесты и скрипты: выполнять готовые задачи, пока они есть (обработчики могут ставить новые). Возвращает число выполненных. */
export async function drainJobs(maxRounds = 50): Promise<number> {
  let n = 0;
  for (let i = 0; i < maxRounds; i++) {
    const jobs = await claim(50);
    if (!jobs.length) break;
    const byBatch = new Map<string, Job[]>(), single: Job[] = [];
    for (const j of jobs) {
      if (batchHandlers[j.kind]) byBatch.set(j.kind, [...(byBatch.get(j.kind) ?? []), j]);
      else single.push(j);
    }
    await Promise.all([...[...byBatch.values()].map(runBatch), ...single.map((j) => runJob(j))]);
    n += jobs.length;
  }
  return n;
}

/**
 * Цикл процесса-воркера, конвейером: до concurrency обычных задач в работе, освободившиеся слоты
 * добираются новыми (медленная задача не держит остальные, как держала пачка с Promise.all). Kind с
 * обработчиком пачки (search.sync) — своя полоса: одна пачка до max задач в работе, следующая — когда она готова.
 * Готовые задачи удаляются групповым коммитом. Слоты добираются, когда свободна четверть (claim — самый
 * дорогой запрос очереди), но не позже чем через REFILL_MS. Очередь пуста — claim не повторяется до NOTIFY
 * jobs с этим kind или pollMs (poll нужен для отложенных задач: повторов и периодических, о них NOTIFY нет).
 */
const REFILL_MS = 50;

export function startWorker(opts: { concurrency?: number; pollMs?: number; leaseSec?: number; kinds?: KindFilter } = {}): { stop(): Promise<void> } {
  const concurrency = opts.concurrency ?? 10;
  const leaseSec = opts.leaseSec ?? LEASE_SEC;
  const pollMs = opts.pollMs ?? 5000;
  const kinds = opts.kinds ?? {};
  const lanes = Object.keys(batchHandlers).filter((k) => allowed(k, kinds));
  const singles: KindFilter = { only: kinds.only?.filter((k) => !lanes.includes(k)), except: [...(kinds.except ?? []), ...lanes] };
  const refillAt = Math.max(1, Math.floor(concurrency / 4));
  const done = groupCommit();

  let stopped = false;
  let dirty = false;                 // NOTIFY или конец задачи, пока цикл был занят: не засыпать
  let wake: (() => void) | null = null;
  // в очереди может быть работа: да на старте, после NOTIFY своего kind, после poll; нет — claim вернул меньше, чем просили
  let wantSingles = true;
  const wantLane = new Map(lanes.map((k) => [k, true]));
  const busyLanes = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  let running = 0;                   // обычных задач в работе
  let lowSince = 0;                  // свободно меньше refillAt: с какого момента ждём добора

  const poke = () => { dirty = true; wake?.(); };
  const nap = (ms: number) => new Promise<void>((resolve) => {
    if (dirty || stopped) { resolve(); return; }
    const t = setTimeout(() => {
      wake = null;
      if (ms >= pollMs) { wantSingles = true; for (const k of lanes) wantLane.set(k, true); }
      resolve();
    }, ms);
    wake = () => { clearTimeout(t); wake = null; resolve(); };
  });
  const track = (p: Promise<void>, onEnd: () => void) => {
    const q = p.catch((e) => console.error('jobs:', e)).finally(() => { inFlight.delete(q); onEnd(); poke(); });
    inFlight.add(q);
  };
  const claimSafe = (limit: number, f: KindFilter) => claim(limit, leaseSec, f).catch((e) => { console.error('jobs claim:', e); return [] as Job[]; });

  // один NOTIFY на транзакцию несёт все её kind через запятую (queue.ts)
  const listening = sql.listen('jobs', (payload) => {
    for (const kind of payload.split(',')) { if (wantLane.has(kind)) wantLane.set(kind, true); else wantSingles = true; }
    poke();
  });
  const loop = (async () => {
    await listening;
    while (!stopped) {
      dirty = false;
      for (const kind of lanes) {
        if (busyLanes.has(kind) || !wantLane.get(kind)) continue;
        const max = batchHandlers[kind].max;
        wantLane.set(kind, false);                   // NOTIFY во время claim вернёт true — не затираем
        const jobs = await claimSafe(max, { only: [kind] });
        if (jobs.length === max) wantLane.set(kind, true);
        if (!jobs.length) continue;
        busyLanes.add(kind);
        track(runBatch(jobs), () => { busyLanes.delete(kind); wantLane.set(kind, true); });
      }
      const free = concurrency - running;
      if (wantSingles && free > 0) {
        if (free >= refillAt || running === 0 || (lowSince && Date.now() - lowSince >= REFILL_MS)) {
          lowSince = 0;
          wantSingles = false;
          const jobs = await claimSafe(free, singles);
          if (jobs.length === free) wantSingles = true;
          for (const j of jobs) { running++; track(runJob(j, done), () => { running--; }); }
        } else if (!lowSince) {
          lowSince = Date.now();
        }
      }
      await nap(lowSince ? Math.max(1, REFILL_MS - (Date.now() - lowSince)) : pollMs);
    }
  })();
  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;
      await Promise.all([...inFlight]);              // задачи в работе доделываются и коммитятся
      await (await listening).unlisten();
    },
  };
}
