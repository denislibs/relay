import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// bigint (OID 20) → number. Все id и seq помещаются в 2^53.
export const sql = postgres(url, {
  max: 10,
  idle_timeout: 20,
  onnotice: () => {},
  types: {
    bigint: { to: 20, from: [20], serialize: (v: number) => String(v), parse: (v: string) => Number(v) },
  },
});

export type Tx = postgres.TransactionSql<{ bigint: number }>;
