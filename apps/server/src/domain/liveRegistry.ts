import { key, PREFIX, valkey } from '../valkey';

/**
 * Кто онлайн — по всей системе. presence:<user> — хэш «процесс → число сокетов»; proc:<pid> — процесс жив
 * (ставится каждые 30 с на 90 с); left:<user> — пауза после ухода последнего сокета (перезагрузка вкладки
 * не «уход»); в ней — метка паузы: «ушёл» объявляет только таймер с этой меткой (leave), так что таймер давней
 * паузы в другом процессе не объявит уход раньше срока и не оставит чужую паузу висеть. Скрипты меняют счётчик и считают сумму атомарно; счётчики умерших процессов стираются по пути.
 * Одиночный узел Valkey: скрипты обращаются к ключам proc:*, вычисленным внутри.
 */
export const PROCESS_ID = crypto.randomUUID();
const ALIVE_SEC = 90;
const graceMs = () => Number(process.env.RELAY_PRESENCE_GRACE_MS ?? 4000);

// сумма по живым процессам; поля умерших удаляются (KEYS[1] — presence:<user>, ARGV[1] — префикс)
const SUM = `
local function total(h, prefix)
  local t, f = 0, redis.call('HGETALL', h)
  for i = 1, #f, 2 do
    if redis.call('EXISTS', prefix .. 'proc:' .. f[i]) == 1 then t = t + tonumber(f[i + 1])
    else redis.call('HDEL', h, f[i]) end
  end
  return t
end`;

const CONNECT = `${SUM}
redis.call('HINCRBY', KEYS[1], ARGV[2], 1)
local returning = redis.call('DEL', KEYS[2])
return { total(KEYS[1], ARGV[1]), returning }`;

const DISCONNECT = `${SUM}
if redis.call('HINCRBY', KEYS[1], ARGV[2], -1) <= 0 then redis.call('HDEL', KEYS[1], ARGV[2]) end
local t = total(KEYS[1], ARGV[1])
if t == 0 then redis.call('SET', KEYS[2], ARGV[4], 'PX', ARGV[3]) end
return t`;

// пауза ещё та же (метка совпала) и сокетов нет — пауза снята, уход объявляет вызвавший
const LEAVE = `${SUM}
if redis.call('GET', KEYS[2]) == ARGV[2] and total(KEYS[1], ARGV[1]) == 0 then
  redis.call('DEL', KEYS[2])
  return 1
end
return 0`;

const COUNT = `${SUM}
return total(KEYS[1], ARGV[1])`;

// ARGV[1] — префикс, ARGV[2..] — id; онлайн: есть сокеты в живом процессе или идёт пауза
const ONLINE = `${SUM}
local out = {}
for i = 2, #ARGV do
  if total(ARGV[1] .. 'presence:' .. ARGV[i], ARGV[1]) > 0 or redis.call('EXISTS', ARGV[1] .. 'left:' .. ARGV[i]) == 1 then
    out[#out + 1] = ARGV[i]
  end
end
return out`;

const run = (script: string, keys: string[], args: (string | number)[]) =>
  valkey().send('EVAL', [script, String(keys.length), ...keys, ...args.map(String)]);

export async function processAlive(pid = PROCESS_ID): Promise<void> {
  await valkey().send('SET', [key('proc:' + pid), '1', 'EX', String(ALIVE_SEC)]);
}

export async function processGone(pid = PROCESS_ID): Promise<void> {
  await valkey().send('DEL', [key('proc:' + pid)]);
}

/** Сокет открыт: total — соединений пользователя во всех живых процессах; returning — вернулся в паузе после ухода. */
export async function connect(userId: number, pid = PROCESS_ID): Promise<{ total: number; returning: boolean }> {
  const [total, returning] = (await run(CONNECT, [key(`presence:${userId}`), key(`left:${userId}`)], [PREFIX, pid])) as [number, number];
  return { total: Number(total), returning: Number(returning) === 1 };
}

/**
 * Сокет закрыт: сколько осталось во всей системе; при 0 начинается пауза с меткой token. Ключ паузы живёт
 * вдвое дольше неё: его снимает таймер (leave), а срок — страховка на случай, если процесс с таймером упал.
 */
export async function disconnect(userId: number, pid = PROCESS_ID, token: string = crypto.randomUUID()): Promise<number> {
  return Number(await run(DISCONNECT, [key(`presence:${userId}`), key(`left:${userId}`)], [PREFIX, pid, graceMs() * 2, token]));
}

/** Пауза token кончилась: true — она всё ещё последняя и сокетов нет (пауза снята, пора объявить «ушёл»). */
export async function leave(userId: number, token: string): Promise<boolean> {
  return Number(await run(LEAVE, [key(`presence:${userId}`), key(`left:${userId}`)], [PREFIX, token])) === 1;
}

/** Открытых сокетов пользователя во всех живых процессах (паузу не учитывает). */
export async function connectionCount(userId: number): Promise<number> {
  return Number(await run(COUNT, [key(`presence:${userId}`)], [PREFIX]));
}

/** Кто из списка онлайн: есть сокеты или идёт пауза после ухода. */
export async function onlineUsers(userIds: number[]): Promise<Set<number>> {
  if (!userIds.length) return new Set();
  const ids = (await run(ONLINE, [], [PREFIX, ...userIds])) as (string | number)[];
  return new Set(ids.map(Number));
}
