import postgres from 'postgres';
import { assertTransportSecure, dbSsl } from './tls';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
assertTransportSecure();   // production: без TLS к базе и Valkey не запускаемся (tls.ts)

// bigint (OID 20) → number. Все id и seq помещаются в 2^53.
export const sql = postgres(url, {
  ssl: dbSsl(),
  max: 10,
  idle_timeout: 20,
  onnotice: () => {},
  types: {
    bigint: { to: 20, from: [20], serialize: (v: number) => String(v), parse: (v: string) => Number(v) },
  },
});

export type Tx = postgres.TransactionSql<{ bigint: number }>;
