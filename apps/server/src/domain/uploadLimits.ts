import { sql } from '../db';
import { key, valkey } from '../valkey';
import { DomainError } from './errors';

/**
 * Пределы загрузок на пользователя (POST /uploads), чтобы один аккаунт не забил хранилище:
 *  - не больше maxPending начатых и не подтверждённых загрузок за последний час (upload_limit);
 *  - не больше perMinute новых загрузок в минуту (flood — как у входа по коду);
 *  - не больше bytesPerHour / bytesPerDay байт, заявленных за час / сутки (upload_quota).
 * Окно счётчика начинается с первой загрузки в нём (ключ Valkey с EXPIRE); отказ несёт retryAfter — сколько ждать.
 * Байты считаются при заявке, а не по факту: отменённая загрузка квоту не возвращает (иначе «начал — отменил» обходит предел).
 * Valkey недоступен — пропускаем (хранилище важнее не остановить, чем идеально ограничить); остальное — Postgres.
 * Горячий путь: один EVAL в Valkey и один count по частичному индексу, параллельно; к S3 — ни одного запроса.
 */
export interface UploadLimits { maxPending: number; perMinute: number; bytesPerHour: number; bytesPerDay: number }

const GB = 1024 ** 3;
const envNum = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const defaults = (): UploadLimits => ({
  maxPending: envNum('UPLOAD_MAX_PENDING', 10),
  perMinute: envNum('UPLOAD_PER_MINUTE', 120),
  bytesPerHour: envNum('UPLOAD_GB_PER_HOUR', 10) * GB,
  bytesPerDay: envNum('UPLOAD_GB_PER_DAY', 50) * GB,
});
let limits = defaults();
export const uploadLimits = (): UploadLimits => limits;
/** Тесты: поменять пределы (без аргумента — вернуть из окружения). */
export function setUploadLimits(next?: Partial<UploadLimits>): void { limits = next ? { ...limits, ...next } : defaults(); }

/** pending старше часа уже не «идёт»: ссылка на PUT живёт минуты, такие подберёт sweepPendingUploads. */
const PENDING_WINDOW_SEC = 3600;

const keys = (userId: number) => [key(`upl:n:${userId}`), key(`upl:h:${userId}`), key(`upl:d:${userId}`)];

// Атомарно: +1 к числу загрузок за минуту, затем байты за час и сутки — если оба влезают, прибавить к обоим.
// Ответ: {0} — можно; {1, ttl} — flood; {2, ttl} — квота байт (ttl — секунд до сброса окна, которое не пустило).
const RESERVE = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end
if n > tonumber(ARGV[2]) then return {1, redis.call('TTL', KEYS[1])} end
local size = tonumber(ARGV[1])
local h = tonumber(redis.call('GET', KEYS[2]) or '0')
local d = tonumber(redis.call('GET', KEYS[3]) or '0')
if h + size > tonumber(ARGV[3]) then local t = redis.call('TTL', KEYS[2]); return {2, t > 0 and t or 3600} end
if d + size > tonumber(ARGV[4]) then local t = redis.call('TTL', KEYS[3]); return {2, t > 0 and t or 86400} end
redis.call('INCRBY', KEYS[2], size)
if redis.call('TTL', KEYS[2]) < 0 then redis.call('EXPIRE', KEYS[2], 3600) end
redis.call('INCRBY', KEYS[3], size)
if redis.call('TTL', KEYS[3]) < 0 then redis.call('EXPIRE', KEYS[3], 86400) end
return {0}`;

const REFUND = `
for i = 1, 2 do
  if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('DECRBY', KEYS[i], ARGV[1]) end
end`;

async function reserve(userId: number, size: number): Promise<[number, number?]> {
  try {
    const r = await valkey().send('EVAL', [RESERVE, '3', ...keys(userId), String(size), String(limits.perMinute), String(limits.bytesPerHour), String(limits.bytesPerDay)]);
    return (r as number[]).map(Number) as [number, number?];
  } catch (e) {
    console.error('upload limits: valkey unavailable, not limiting:', (e as Error).message);
    return [0];
  }
}

/** Проверка перед записью pending (createUpload): бросает flood / upload_quota / upload_limit с retryAfter. */
export async function checkUploadAllowed(userId: number, size: number): Promise<void> {
  const [[verdict, ttl], [p]] = await Promise.all([
    reserve(userId, size),
    sql`select count(*)::int as n from attachments where owner_id = ${userId} and status = 'pending'
          and created_at > now() - ${PENDING_WINDOW_SEC} * interval '1 second'`,
  ]);
  if (verdict === 1) throw new DomainError('flood', 'uploads per minute', Math.max(1, ttl ?? 60));
  if (verdict === 2) throw new DomainError('upload_quota', 'upload bytes', Math.max(1, ttl ?? 3600));
  if ((p.n as number) >= limits.maxPending) {
    // байты этой заявки не ушли в хранилище — вернуть их в квоту
    const [, h, d] = keys(userId);
    await valkey().send('EVAL', [REFUND, '2', h, d, String(size)]).catch(() => {});
    throw new DomainError('upload_limit', 'pending uploads', 60);
  }
}

/** Для /dev/stats: сколько пользователь хранит и сколько квоты уже израсходовал. */
export async function storageUsage(userId: number): Promise<{
  files: number; bytes: number; pending: number; variantsBytes: number;
  quota: { hourBytes: number; dayBytes: number; minuteUploads: number } & UploadLimits;
}> {
  const [n, h, d] = keys(userId);
  const [[own], [vars], counters] = await Promise.all([
    sql`select count(*) filter (where status = 'ready')::int as files, coalesce(sum(size) filter (where status = 'ready'), 0)::bigint as bytes,
               count(*) filter (where status = 'pending')::int as pending
          from attachments where owner_id = ${userId}`,
    sql`select coalesce(sum(v.size), 0)::bigint as bytes from attachment_variants v join attachments a on a.id = v.attachment_id where a.owner_id = ${userId}`,
    valkey().send('MGET', [n, h, d]).then((r) => (r as (string | null)[]).map((x) => Number(x ?? 0))).catch(() => [0, 0, 0]),
  ]);
  return {
    files: own.files as number, bytes: Number(own.bytes), pending: own.pending as number, variantsBytes: Number(vars.bytes),
    quota: { minuteUploads: counters[0], hourBytes: counters[1], dayBytes: counters[2], ...limits },
  };
}
