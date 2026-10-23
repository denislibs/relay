import postgres from 'postgres';
import { assertTransportSecure, dbSsl } from './tls';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
assertTransportSecure();   // production: без TLS к базе и Valkey не запускаемся (tls.ts)

// bigint (OID 20) → number. Все id и seq помещаются в 2^53.
export const sql = postgres(url, {
  ssl: dbSsl(),
  // транзакция отправки короткая (пакетный журнал, NOTIFY после коммита), но получателей много:
  // при 10 соединениях сервер под нагрузкой ждал свободное, а не базу
  max: Number(process.env.DB_POOL ?? 30),
  idle_timeout: 20,
  onnotice: () => {},
  types: {
    bigint: { to: 20, from: [20], serialize: (v: number) => String(v), parse: (v: string) => Number(v) },
  },
});

export type Tx = postgres.TransactionSql<{ bigint: number }>;

/**
 * Действия после коммита. pg_notify внутри транзакции заставляет Postgres коммитить такие транзакции строго
 * по одной (замок на очередь уведомлений держится до конца коммита) — на pgbench это 4170 → 640 tps. Поэтому
 * журнал и очередь задач не шлют NOTIFY сами, а регистрируют его здесь; sql.begin после успешного коммита
 * выполняет накопленное. Откат — ничего не уходит. Окно «закоммитили, а процесс упал до NOTIFY» закрывает
 * клиент: синхронизация при переподключении и редкая сверочная.
 */
const commitHooks = new WeakMap<object, (() => Promise<void>)[]>();

/** Выполнить fn после коммита транзакции db. false — db не транзакция (автокоммит): делать сразу. */
export function onCommit(db: object, fn: () => Promise<void>): boolean {
  const hooks = commitHooks.get(db);
  if (!hooks) return false;
  hooks.push(fn);
  return true;
}

type BeginFn = <T>(cb: (tx: Tx) => T | Promise<T>) => Promise<T>;
const rawBegin = sql.begin.bind(sql) as unknown as (opts: string | ((tx: Tx) => unknown), cb?: (tx: Tx) => unknown) => Promise<unknown>;
function beginWithHooks(a: string | ((tx: Tx) => unknown), b?: (tx: Tx) => unknown): Promise<unknown> {
  const cb = (typeof a === 'function' ? a : b) as (tx: Tx) => unknown;
  let hooks: (() => Promise<void>)[] = [];
  let ref: Tx | null = null;
  const wrapped = (tx: Tx) => { ref = tx; hooks = []; commitHooks.set(tx, hooks); return cb(tx); };
  const done = typeof a === 'function' ? rawBegin(wrapped) : rawBegin(a, wrapped);
  return done.then(
    async (res) => {
      if (ref) commitHooks.delete(ref);
      for (const h of hooks) await h().catch((e) => console.error('after commit:', e));
      return res;
    },
    (e) => { if (ref) commitHooks.delete(ref); throw e; },
  );
}
(sql as unknown as { begin: BeginFn }).begin = beginWithHooks as unknown as BeginFn;
