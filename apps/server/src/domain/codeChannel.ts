// Канал доставки одноразовых кодов — только настройка из окружения, без базы: её читает и проверка старта (tls.ts).
export type CodeChannel = 'dev' | 'log' | 'telegram' | 'none';
export type CodeKind = 'login' | 'signup' | 'recovery';
/** to — телефон или логин (вход, регистрация) либо почта (восстановление); expiresAt — ISO. */
export interface CodeItem { to: string; kind: CodeKind; code: string; expiresAt?: string }

export type Env = Record<string, string | undefined>;
const CHANNELS = ['dev', 'log', 'telegram'];

export function codeChannel(env: Env = process.env): CodeChannel {
  const v = env.CODE_DELIVERY?.trim();
  if (v) {
    if (!CHANNELS.includes(v)) throw new Error(`CODE_DELIVERY must be ${CHANNELS.join(', ')}, not ${v}`);
    return v as CodeChannel;
  }
  if (env.DEV_LOGIN === '1') return 'dev';
  if (env.LOG_LOGIN_CODES === '1') return 'log';
  return 'none';
}

/** Канал доставляет код кому-то вне приложения — значит, код можно выдать и без открытых сеансов. */
export const deliverable = (ch: CodeChannel): boolean => ch !== 'none';
/** Внешний канал — через очередь задач, после коммита. */
export const queued = (ch: CodeChannel): boolean => ch === 'telegram';

/** Что мешает выбранному каналу работать (для отказа старта в production, tls.ts). */
export function codeDeliveryProblems(env: Env): string[] {
  let ch: CodeChannel;
  try { ch = codeChannel(env); } catch (e) { return [(e as Error).message]; }
  const out: string[] = [];
  if (env.CODE_DELIVERY === 'dev' || env.CODE_DELIVERY === 'log') out.push(`CODE_DELIVERY=${env.CODE_DELIVERY} is not allowed in production`);
  if (ch === 'telegram') {
    if (!env.TELEGRAM_BOT_TOKEN) out.push('CODE_DELIVERY=telegram: set TELEGRAM_BOT_TOKEN');
    if (!/^-?\d+$/.test(env.TELEGRAM_OWNER_CHAT_ID ?? '')) out.push('CODE_DELIVERY=telegram: set TELEGRAM_OWNER_CHAT_ID (numeric chat id)');
    if (env.TELEGRAM_API_URL && !env.TELEGRAM_API_URL.startsWith('https://')) out.push('TELEGRAM_API_URL: https://…');
  }
  return out;
}
