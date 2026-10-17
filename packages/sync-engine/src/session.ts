/**
 * Конец сеанса в движке: sessionTerminated с сервера, 401 на любом HTTP (запросы, операции, загрузка файлов)
 * или 401 при проверке после неудачного подключения. Движок перестаёт подключаться и отправлять, говорит
 * интерфейсу (status.terminated + reason), стирает локальные данные (как выход) и закрывается; хост его забывает.
 * engine.ts только подключает этот модуль к своему состоянию через SessionEndHost.
 */
export type EndReason = 'logout' | 'terminated';

export interface SessionEndHost {
  httpBase: string;
  headers?: Record<string, string>;
  /** HTTP движка (dev: имитатор сети); по умолчанию fetch */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** движок уже закрыт (вкладка/хост закрывают его сами) */
  closed(): boolean;
  /** перестать подключаться и отправлять: очередь операций, транспорт */
  stop(): void;
  /** статус — подпискам сразу */
  notify(): void;
  /** идёт работа, которую стоит недолго подождать (синхронизация, отправка) */
  working(): boolean;
  run(fn: () => Promise<unknown>): void;
  /** последние патчи подпискам и закрытие движка (таймеры, подписки); false — уже закрыт */
  shutdown(): boolean;
  /** стереть данные, закрыть и удалить IndexedDB */
  wipe(): Promise<void>;
}

const WAIT_MS = 3000;
const PROBE_MS = 3000;

export class SessionEnd {
  /** почему сеанс закончился; null — сеанс жив */
  reason: EndReason | null = null;
  private done: () => void = () => {};
  private lastProbe = 0;

  constructor(private h: SessionEndHost) {}

  get ended(): boolean { return this.reason !== null; }

  /** Данные стёрты, движок закрыт. */
  onDone(cb: () => void): void { this.done = cb; }

  /** Поля статуса для интерфейса. */
  status(): Record<string, unknown> { return this.reason ? { terminated: true, terminatedReason: this.reason } : {}; }

  end(reason: EndReason = 'terminated'): void {
    if (this.reason || this.h.closed()) return;
    this.reason = reason;
    this.h.stop();
    this.h.notify();
    this.h.run(async () => {
      // идущая работа без сети обрывается сама — ждём её недолго, как resetLocal
      const until = Date.now() + WAIT_MS;
      while (this.h.working() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      if (!this.h.shutdown()) return;
      try { await this.h.wipe(); } catch { /* база уже закрывается */ }
      this.done();
    });
  }

  /** Ответ HTTP: 401 — сеанса больше нет. true — обработано. */
  unauthorized(status: number): boolean {
    if (status !== 401) return false;
    this.end('terminated');
    return true;
  }

  /** Сокет не открылся: может быть, сеанс завершён, пока нас не было (сервер отвечает 401 на подключение). */
  probe(): void {
    if (this.reason || this.h.closed() || Date.now() - this.lastProbe < PROBE_MS) return;
    this.lastProbe = Date.now();
    (this.h.fetch ?? fetch)(this.h.httpBase + '/me', { headers: this.h.headers, credentials: 'include' })
      .then((r) => { this.unauthorized(r.status); }, () => { /* сети нет */ });
  }
}
