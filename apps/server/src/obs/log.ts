import { BUILD_ID } from './metrics';

/**
 * Структурный лог горячих путей: одна строка JSON на событие — {ts, level, msg, build, proc, ...поля}. Сборщик
 * логов (docker logs, Loki — когда появится) фильтрует по reqId, userId, build без разбора текста.
 *
 * Секретов в логе нет: поля с именами вроде code/token/secret/password/phone/cookie/sig выбрасываются целиком,
 * у ошибок — только имя, сообщение и первые строки стека. Коды входа сюда не передаются вовсе (codeDelivery.ts
 * пишет только исход и маску адресата).
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const SECRET = /code|token|secret|passw|phone|cookie|authori|sig|otp|dek|key$/i;
/** поля, которые выглядят как секрет по имени, но им не являются */
const SAFE = new Set(['status', 'kind', 'op', 'route', 'reqId', 'userId', 'sessionId', 'build', 'clientBuild', 'source', 'result']);
const STACK_LINES = 6;

let proc = 'server';
/** Роль процесса в каждой строке (server | worker | keys). */
export function setLogProc(p: string): void { proc = p; }

export function errorFields(e: unknown): Fields {
  if (e instanceof Error) {
    return { err: e.message.slice(0, 500), errName: e.name, stack: e.stack?.split('\n').slice(1, STACK_LINES + 1).map((s) => s.trim()).join(' | ') };
  }
  return { err: String(e).slice(0, 500) };
}

function clean(f: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined) continue;
    if (!SAFE.has(k) && SECRET.test(k)) continue;
    if (k === 'error' || k === 'err' && typeof v !== 'string') { Object.assign(out, errorFields(v)); continue; }
    out[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v;
  }
  return out;
}

/** Куда пишет лог (тесты подменяют). */
let sink: (line: string, level: Level) => void = (line, level) => {
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};
export function setLogSink(fn: typeof sink): () => void { const prev = sink; sink = fn; return () => { sink = prev; }; }

function write(level: Level, msg: string, fields: Fields = {}): void {
  let line: string;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), level, msg, build: BUILD_ID, proc, ...clean(fields) });
  } catch {
    line = JSON.stringify({ ts: new Date().toISOString(), level, msg, build: BUILD_ID, proc, note: 'fields not serializable' });
  }
  sink(line, level);
}

export const log = {
  debug: (msg: string, f?: Fields) => { if (process.env.LOG_DEBUG === '1') write('debug', msg, f); },
  info: (msg: string, f?: Fields) => write('info', msg, f),
  warn: (msg: string, f?: Fields) => write('warn', msg, f),
  error: (msg: string, f?: Fields) => write('error', msg, f),
};
