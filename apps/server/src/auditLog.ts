// Журнал аудита сервиса ключей — цепочка: каждая запись несёт номер, хэш предыдущей и HMAC (KEY_SERVICE_AUDIT_KEY)
// над собой и этим хэшем. Удалить, вставить, переставить или поправить запись незаметно нельзя: проверка
// (verifyAuditLog, `bun apps/server/src/auditVerify.ts файл`) находит первое место разрыва. Без ключа новую цепочку
// не подделать. Записи уходят и в stdout (сбор логов Docker → внешнее хранилище) — уже отправленное взломщик не
// перепишет; раз в минуту — отметка «жив» (heartbeat): обрезанный хвост виден по разрыву во времени.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export type AuditLine = { seq: number; at: string; prev: string; mac: string } & Record<string, unknown>;
const GENESIS = 'genesis';

/** Каноническая строка записи без mac: ключи по алфавиту — одна и та же запись даёт одни и те же байты. */
const canonical = (e: Record<string, unknown>): string =>
  JSON.stringify(Object.keys(e).filter((k) => k !== 'mac').sort().reduce((o, k) => { o[k] = e[k]; return o; }, {} as Record<string, unknown>));
const macOf = (key: Buffer, e: Record<string, unknown>) => createHmac('sha256', key).update(canonical(e)).digest('base64url');

export interface AuditChain { append(entry: Record<string, unknown>): AuditLine; head(): { seq: number; mac: string } }

/** Цепочка: продолжает файл, если он есть (последняя запись — её голова), иначе начинается с genesis. */
export function createAuditChain(o: { key: Buffer; file?: string; sink?: (line: string) => void; now?: () => Date }): AuditChain {
  let seq = 0, prev = GENESIS;
  if (o.file && existsSync(o.file)) {
    const last = readFileSync(o.file, 'utf8').trimEnd().split('\n').filter(Boolean).at(-1);
    if (last) { const l = JSON.parse(last) as AuditLine; seq = l.seq; prev = l.mac; }
  }
  const sink = o.sink ?? ((line: string) => console.log(line));
  return {
    append(entry) {
      const body = { ...entry, seq: seq + 1, at: (o.now?.() ?? new Date()).toISOString(), prev };
      const line = { ...body, mac: macOf(o.key, body) } as AuditLine;
      const text = JSON.stringify(line);
      if (o.file) appendFileSync(o.file, text + '\n');   // сначала на диск, потом считаем записанным
      sink(text);
      seq = line.seq; prev = line.mac;
      return line;
    },
    head: () => ({ seq, mac: prev }),
  };
}

/** Проверка цепочки: ok — всё сошлось; иначе номер строки (с 1) и причина первого разрыва. */
export function verifyAuditLog(text: string, key: Buffer): { ok: true; count: number } | { ok: false; line: number; reason: string } {
  let prev: string | null = null, seq: number | null = null, n = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    n++;
    let l: AuditLine;
    try { l = JSON.parse(raw) as AuditLine; } catch { return { ok: false, line: n, reason: 'not JSON' }; }
    const want = Buffer.from(macOf(key, l)), got = Buffer.from(String(l.mac ?? ''));
    if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, line: n, reason: 'bad mac (edited or forged)' };
    if (prev !== null && l.prev !== prev) return { ok: false, line: n, reason: 'chain broken (removed or reordered)' };
    if (seq !== null && l.seq !== seq + 1) return { ok: false, line: n, reason: `seq jumps ${seq} → ${l.seq}` };
    prev = l.mac; seq = l.seq;
  }
  return { ok: true, count: n };
}

/** Ключ журнала из env (base64, 32 байта). Нет — случайный на время процесса (dev): цепочка есть, проверить снаружи нечем. */
export function auditKeyFromEnv(): Buffer {
  const raw = process.env.KEY_SERVICE_AUDIT_KEY;
  if (raw) {
    const k = Buffer.from(raw, 'base64');
    if (k.length < 32) throw new Error('KEY_SERVICE_AUDIT_KEY: need 32 bytes (base64)');
    return k;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('KEY_SERVICE_AUDIT_KEY is required in production');
  console.warn('key service: KEY_SERVICE_AUDIT_KEY not set — audit chain key is ephemeral (dev)');
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
}
