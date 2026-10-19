import { sql } from '../db';
import { handlers, PermanentError } from './handlers';
import { claim, complete, fail, LEASE_SEC, type Job, type KindFilter } from './queue';

/** Выполнить одну задачу: успех — complete, ошибка — fail (PermanentError и неизвестный kind — без повтора). */
export async function runJob(job: Job): Promise<void> {
  const h = handlers[job.kind];
  if (!h) { await fail(job, new Error(`no handler for ${job.kind}`), { retry: false }); return; }
  try {
    const res = await h(job.payload, job);
    await complete(job, res ? res.again : undefined);
  } catch (e) {
    await fail(job, e, { retry: !(e instanceof PermanentError) });
  }
}

/** Тесты и скрипты: выполнять готовые задачи, пока они есть (обработчики могут ставить новые). Возвращает число выполненных. */
export async function drainJobs(maxRounds = 50): Promise<number> {
  let n = 0;
  for (let i = 0; i < maxRounds; i++) {
    const jobs = await claim(50);
    if (!jobs.length) break;
    await Promise.all(jobs.map(runJob));
    n += jobs.length;
  }
  return n;
}

/**
 * Цикл процесса-воркера: забирает пачку, выполняет, повторяет; пусто — спит до NOTIFY jobs или pollMs
 * (poll нужен для отложенных задач: повторов и периодических, о них NOTIFY не приходит).
 */
export function startWorker(opts: { concurrency?: number; pollMs?: number; leaseSec?: number; kinds?: KindFilter } = {}): { stop(): Promise<void> } {
  const concurrency = opts.concurrency ?? 10;
  const leaseSec = opts.leaseSec ?? LEASE_SEC;
  const pollMs = opts.pollMs ?? 5000;
  let stopped = false;
  let poked = false;                 // NOTIFY пришёл, пока воркер был занят: не засыпать
  let wake: (() => void) | null = null;
  const nap = () => new Promise<void>((resolve) => {
    if (poked || stopped) { resolve(); return; }
    const t = setTimeout(() => { wake = null; resolve(); }, pollMs);
    wake = () => { clearTimeout(t); wake = null; resolve(); };
  });
  const listening = sql.listen('jobs', () => { poked = true; wake?.(); });
  const loop = (async () => {
    await listening;
    while (!stopped) {
      poked = false;
      const jobs = await claim(concurrency, leaseSec, opts.kinds).catch((e) => { console.error('jobs claim:', e); return [] as Job[]; });
      if (jobs.length) { await Promise.all(jobs.map(runJob)); continue; }
      await nap();
    }
  })();
  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;                                  // текущая пачка доделывается
      await (await listening).unlisten();
    },
  };
}
