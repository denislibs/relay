import { getAll, write } from './idb';

/**
 * Очередь операций настроек (профиль, контакты, уведомления, приватность, сеансы): HTTP-запросы,
 * которые переживают офлайн и перезапуск. Независима от очереди сообщений.
 *
 * - key — ключ схлопывания: новая операция с тем же ключом заменяет ещё не отправленную на её же месте
 *   в очереди (PATCH — сливает поля, остальное — заменяет). Уже отправленную (в полёте) не трогает —
 *   новая встаёт за ней, и последней на сервер придёт последняя правка;
 * - отправка строго по одной, в порядке постановки — и между разными ключами тоже;
 * - сеть/5xx — повтор с нарастающей паузой; 4xx — операция выбрасывается, в failures — событие opFailed.
 *   Слитый PATCH падает целиком: отказ по одному полю (bio_too_long) теряет и соседнее (новое имя) —
 *   поэтому интерфейс проверяет поля до постановки;
 * - оптимистичное состояние не хранится отдельно: его выводят из базы сервера + list (см. profile.ts meView).
 *   Поэтому оно само переживает перезапуск и само откатывается, когда операция ушла из очереди.
 *
 * ПРАВИЛО для каждого раздела (B3+): hooks.done обязан сразу сделать ответ 2xx новой базой своего состояния.
 * Иначе между уходом операции из очереди и приходом записи журнала вид откатится к старой базе
 * и тут же вернётся — переключатель «мигнёт» при подтверждении.
 */
export type OpMethod = 'PATCH' | 'PUT' | 'POST' | 'DELETE';
export interface PendingOp { id: number; key: string; method: OpMethod; path: string; body?: unknown; at: number }
export type OpSpec = { key: string; method: OpMethod; path: string; body?: unknown };
export interface OpFailure { id: number; key: string; code: string; at: number }

export interface OpsHooks {
  /** можно отправлять (сокет открыт и журнал догнан) */
  canSend(): boolean;
  /** 2xx: ответ сервера — новая база для оптимистичного состояния */
  done(op: PendingOp, value: unknown): void;
  /** состояние очереди изменилось — пересчитать подписки */
  changed(): void;
  /** фоновая задача движка (whenIdle её дождётся) */
  run(fn: () => Promise<unknown>): void;
  /** 401: сеанса больше нет — операция не выбрасывается, движок уходит в «сеанс завершён» */
  unauthorized?(): void;
}

const MAX_FAILURES = 20;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export async function loadOps(db: IDBDatabase): Promise<PendingOp[]> {
  return (await getAll<PendingOp>(db, 'ops')).sort((a, b) => a.id - b.id);
}

export class Ops {
  /** очередь в порядке отправки */
  list: PendingOp[];
  /** последние отказы сервера (id растёт): интерфейс показывает тост на каждый новый */
  failures: OpFailure[] = [];
  /** изменилось с последнего прохода подписок */
  dirty = false;
  private inflight: number | null = null;
  private pumping = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private nextId: number;
  private nextFailure = 1;
  private closed = false;
  /** растёт при forget(): ответ на операцию, отправленную до этого, принадлежит прежнему миру */
  private gen = 0;

  constructor(
    private db: IDBDatabase,
    list: PendingOp[],
    private http: { base: string; headers?: Record<string, string>; backoffMs?: [number, number] },
    private hooks: OpsHooks,
  ) {
    this.list = list;
    this.nextId = list.reduce((m, o) => Math.max(m, o.id), 0) + 1;
  }

  /** Поставить операцию; промис — когда она записана в IDB (дальше уйдёт сама). */
  async enqueue(spec: OpSpec): Promise<void> {
    const i = this.list.findIndex((o) => o.key === spec.key && o.id !== this.inflight);
    // схлопывание — на месте прежней (тот же id: порядок между ключами и после перезапуска сохраняется)
    const op: PendingOp = { id: i >= 0 ? this.list[i].id : this.nextId++, key: spec.key, method: spec.method, path: spec.path, at: Date.now() };
    if (spec.body !== undefined) op.body = spec.body;
    if (i >= 0) {
      const old = this.list[i];
      if (old.method === 'PATCH' && op.method === 'PATCH' && old.path === op.path && plain(old.body) && plain(op.body)) op.body = { ...old.body, ...op.body };
      this.list = this.list.map((o, k) => (k === i ? op : o));
    } else {
      this.list = [...this.list, op];
    }
    this.dirty = true;
    this.hooks.changed();
    await write(this.db, { put: { ops: [op] }, del: {} });
    this.kick();
  }

  get busy(): boolean { return this.pumping; }

  /** Есть ли что-то, что сейчас должно уходить (для whenIdle). */
  get sending(): boolean { return this.pumping || (this.list.length > 0 && !this.retryTimer && this.hooks.canSend()); }

  /** Связь вернулась: повтор — сразу, без паузы. */
  resume(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.attempt = 0;
    this.kick();
  }

  kick(): void {
    if (this.pumping || this.closed || this.retryTimer || !this.list.length || !this.hooks.canSend()) return;
    this.pumping = true;
    this.hooks.run(async () => {
      try {
        while (!this.closed && this.hooks.canSend()) {
          const op = this.list[0];
          if (!op) break;
          this.inflight = op.id;
          const gen = this.gen;
          const r = await this.send(op);
          this.inflight = null;
          if (this.closed) break;
          if (gen !== this.gen) continue;   // очередь забыли, пока ждали ответа: результат не применяем
          if ('retry' in r) { this.backoff(); break; }
          this.attempt = 0;
          this.list = this.list.filter((o) => o.id !== op.id);
          await write(this.db, { put: {}, del: { ops: [op.id] } });
          if (r.ok) this.hooks.done(op, r.value);
          else {
            this.failures = [...this.failures, { id: this.nextFailure++, key: op.key, code: r.code, at: Date.now() }].slice(-MAX_FAILURES);
          }
          this.dirty = true;
          this.hooks.changed();
        }
      } finally {
        this.inflight = null;
        this.pumping = false;
      }
    });
  }

  /** Забыть очередь (база сервера пересоздана — операции относятся к другому миру). IDB чистит Store.wipe. */
  forget(): void {
    this.gen++;
    this.list = [];
    this.dirty = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  item(): { key: string; pending: number; keys: string[]; failures: OpFailure[] } {
    return { key: 'ops', pending: this.list.length, keys: [...new Set(this.list.map((o) => o.key))], failures: this.failures };
  }

  private backoff(): void {
    const [min, max] = this.http.backoffMs ?? [500, 30_000];
    const ms = Math.min(max, min * 2 ** this.attempt++);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.kick(); }, ms);
  }

  private async send(op: PendingOp): Promise<{ ok: true; value: unknown } | { ok: false; code: string } | { retry: true }> {
    try {
      const res = await fetch(this.http.base + op.path, {
        method: op.method,
        headers: { 'content-type': 'application/json', ...(this.http.headers ?? {}) },
        credentials: 'include',
        body: op.body === undefined ? undefined : JSON.stringify(op.body),
      });
      if (res.ok) return { ok: true, value: await res.json().catch(() => null) };
      if (res.status === 401) { this.hooks.unauthorized?.(); return { retry: true }; }
      if (res.status >= 500 || res.status === 408 || res.status === 429) return { retry: true };
      const j = (await res.json().catch(() => null)) as { code?: unknown } | null;
      return { ok: false, code: typeof j?.code === 'string' ? j.code : 'http_' + res.status };
    } catch {
      return { retry: true };   // сети нет — повторим
    }
  }
}
