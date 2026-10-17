import type { DevLog } from './devlog';
import { cutUrl } from './devlog';
import type { NetProfile } from './types';

/**
 * Имитатор сети раздела «Для разработчиков» (влияет только на этот движок, сервер не меняется).
 * Кадры имитирует транспорт (transport.ts), HTTP движка — simFetch ниже.
 * Состояние — в памяти воркера; с persist — offline и profile ещё и в IDB meta.devSim (применяются при открытии движка).
 */
export interface SimState {
  offline: boolean;
  profile: NetProfile | null;
  /** выбросить следующий входящий updates (проверка дыр в seq) */
  dropNextUpdates: boolean;
  /** следующий ответ на sync — как tooLong */
  forceTooLong: boolean;
  /** offline и profile переживают перезапуск */
  persist: boolean;
  /** сколько кадров имитатор уже потерял/выбросил: ожидание ответа повторяет запрос, только если терять мог он */
  losses: number;
}

export const newSim = (): SimState => ({ offline: false, profile: null, dropNextUpdates: false, forceTooLong: false, persist: false, losses: 0 });

/** Имитатор может терять кадры: только тогда движок ждёт ответ с таймаутом (вне имитатора WS-кадры не теряются). */
export const lossy = (s: SimState): boolean => s.dropNextUpdates || (!!s.profile && s.profile.lossPct > 0);

export const simActive = (s: SimState): boolean => s.offline || !!s.profile || s.dropNextUpdates || s.forceTooLong;

const SIM_META = 'devSim';
type Persisted = Pick<SimState, 'offline' | 'profile'>;

export async function loadSim(db: IDBDatabase): Promise<Persisted | null> {
  try {
    const row = await new Promise<{ v: Persisted } | undefined>((resolve, reject) => {
      const r = db.transaction('meta').objectStore('meta').get(SIM_META);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return row?.v ?? null;
  } catch { return null; }
}

export function saveSim(db: IDBDatabase, s: SimState): void {
  try {
    const os = db.transaction('meta', 'readwrite').objectStore('meta');
    if (s.persist && (s.offline || s.profile)) os.put({ k: SIM_META, v: { offline: s.offline, profile: s.profile } });
    else os.delete(SIM_META);
  } catch { /* база закрыта */ }
}

export function normProfile(p: NetProfile | null): NetProfile | null {
  return p ? { latency: +p.latency || 0, jitter: +p.jitter || 0, lossPct: Math.min(100, Math.max(0, +p.lossPct || 0)), kbps: +p.kbps || 0 } : null;
}

/** Задержка одного направления: половина latency, джиттер, время на передачу size байт при kbps. */
export function oneWay(p: NetProfile, size: number): number {
  return Math.max(0, p.latency / 2 + (Math.random() * (p.jitter || 0)) / 2 + (p.kbps > 0 ? (size * 8) / p.kbps : 0));
}
export const lost = (p: NetProfile | null) => !!p && p.lossPct > 0 && Math.random() * 100 < p.lossPct;

/** Путь запроса для журнала: без хоста и без query (там бывает текст поиска). */
function pathOf(url: string): string {
  try { const u = new URL(url); return u.pathname + (u.search ? '?…' : ''); } catch { return cutUrl(url); }
}
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const bodySize = (b: unknown): number => (typeof b === 'string' ? b.length : b && typeof (b as Blob).size === 'number' ? (b as Blob).size : 0);

/**
 * HTTP движка: все запросы идут через эту обёртку — имитатор и журнал.
 * Офлайн отказывает новым запросам как сеть; запрос, ушедший до включения офлайна, завершается (сервер его уже выполнил).
 */
export function simFetch(log: DevLog, sim: SimState): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const t0 = Date.now();
    const method = init?.method ?? 'GET';
    const path = pathOf(url);
    if (sim.offline) { log.record('engine', 'http', { method, path, error: 'offline (dev)' }); throw new TypeError('Failed to fetch (dev: offline)'); }
    if (sim.profile) await sleep(oneWay(sim.profile, bodySize(init?.body)));
    let res: Response;
    try { res = await fetch(url, init); }
    catch (err) { log.record('engine', 'http', { method, path, error: cutUrl(String((err as Error)?.message ?? err)) }, undefined, Date.now() - t0); throw err; }
    const size = Number(res.headers.get('content-length')) || undefined;
    if (sim.profile) await sleep(oneWay(sim.profile, size ?? 0));
    log.record('engine', 'http', { method, path, status: res.status }, size, Date.now() - t0);
    return res;
  };
}

/**
 * Ожидание ответа под имитатором потерь: только пока имитатор может терять кадры (вне его WS-кадры не теряются,
 * и медленный ответ — не повод что-то повторять). Срабатывает, если за ms после запроса имитатор действительно
 * потерял кадр; иначе ждёт дальше. Без потерь — ни таймера, ни поведения.
 */
export function watchLoss(sim: SimState, ms: number, onLoss: () => void): () => void {
  if (!lossy(sim)) return () => {};
  const l0 = sim.losses;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    timer = setTimeout(() => {
      timer = null;
      if (sim.losses !== l0) onLoss();
      else if (lossy(sim)) arm();
    }, ms);
  };
  arm();
  return () => { if (timer) clearTimeout(timer); timer = null; };
}
