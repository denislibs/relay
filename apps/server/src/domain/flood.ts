import { hit } from '../valkey';
import { DomainError } from './errors';

/**
 * Лимиты действий (антифлуд, как FLOOD_WAIT в Telegram): на каждое действие — несколько окон, короткое (всплеск)
 * и длинное (поток). Счётчик — hit() в Valkey (окна по часам, общие для всех процессов). Превысил — DomainError('flood')
 * с retryAfter: секунд до конца окна, которое не пустило (HTTP — 429 и Retry-After, WebSocket — err с retryAfter).
 * Отказы тоже считаются: долбёжка не продлевает ожидание (окно фиксированное), но и не пролезает.
 * Valkey недоступен — hit() даёт 0, лимит не мешает работе.
 *
 * Настройка без сборки — переменными окружения: RELAY_LIMIT_<ИМЯ>="n/сек,n/сек" (например RELAY_LIMIT_SEND="20/10,600/3600"),
 * RELAY_LIMIT_<ИМЯ>=off — выключить одно; RELAY_LIMITS=off — все (аварийный выключатель). Таблица и смысл — docs/protection.md.
 */
export type Window = [n: number, sec: number];

export const LIMITS = {
  /** сообщение (кроме пересылки): 30 за 10 с, 120 в минуту, 1500 в час */
  send: [[30, 10], [120, 60], [1500, 3600]],
  /** пересланное сообщение: выделение до 100 уходит одним махом */
  forward: [[100, 30], [1000, 3600]],
  /** реакция (поставить, снять, сменить) */
  react: [[30, 10], [600, 3600]],
  /** «печатает…»: лишние молча отбрасываются (клиент шлёт раз в несколько секунд на чат) */
  typing: [[10, 5]],
  /** новая группа или канал */
  chatCreate: [[5, 60], [50, 86_400]],
  /** личный чат с человеком (открыть или создать): основной путь спама по незнакомым */
  directOpen: [[30, 60], [300, 86_400]],
  /** добавить контакт и найти человека по номеру или @имени (перебор номеров) */
  contactAdd: [[20, 60], [300, 86_400]],
  lookup: [[30, 60], [500, 86_400]],
  /** поиск: сообщения, медиа, люди, каналы */
  search: [[30, 10], [1000, 3600]],
  /** звонок 1:1 (звонок собеседнику) */
  callRing: [[10, 60], [60, 3600]],
  /** ответ на звонок — выдача учётки TURN */
  callAccept: [[20, 60], [200, 3600]],
  /** начать звонок группы или конференцию */
  groupCallStart: [[5, 60], [30, 3600]],
  /** войти в звонок группы — выдача токена LiveKit */
  groupCallJoin: [[20, 60], [300, 3600]],
  /** позвать в конференцию (звонит людям) */
  groupCallInvite: [[10, 60], [100, 3600]],
  /** вход по коду: на страну (префикс номера) и на весь сервер за сутки (бюджет; 80% — предупреждение в лог) */
  loginPrefix: [[500, 3600]],
  loginGlobal: [[5000, 86_400]],
  /** «Войти через Telegram»: всплеск с адреса (часовой лимит на адрес — в telegramLogin.ts) и на весь сервер */
  telegramIp: [[5, 60]],
  telegramGlobal: [[2000, 3600]],
} satisfies Record<string, Window[]>;

export type LimitName = keyof typeof LIMITS;

const overrides = new Map<LimitName, Window[] | null>();

/** Тесты: заменить окна лимита (null — выключить), без аргументов — вернуть всё как было. */
export function setLimit(name?: LimitName, windows?: Window[] | null): void {
  if (!name) { overrides.clear(); return; }
  overrides.set(name, windows ?? null);
}

const envName = (name: string) => 'RELAY_LIMIT_' + name.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();

/** Окна лимита: тест → переменная окружения → таблица. null — лимит выключен. */
export function windowsOf(name: LimitName, env: Record<string, string | undefined> = process.env): Window[] | null {
  if (overrides.has(name)) return overrides.get(name)!;
  if (env.RELAY_LIMITS === 'off') return null;
  const raw = env[envName(name)]?.trim();
  if (raw === 'off') return null;
  if (raw) {
    const parsed = raw.split(',').map((w) => w.trim().split('/').map(Number)).filter(([n, s]) => n > 0 && s > 0) as Window[];
    if (parsed.length) return parsed;
  }
  return LIMITS[name];
}

/** Секунд до конца окна hit() (окна выровнены по часам). */
const left = (sec: number, now = Date.now()) => Math.max(1, Math.ceil(sec - (now / 1000) % sec));

/** Засчитать действие. 0 — можно; иначе — секунд до повтора (самое долгое из превышенных окон). */
export async function count(name: LimitName, subject: string | number): Promise<number> {
  const ws = windowsOf(name);
  if (!ws) return 0;
  const used = await Promise.all(ws.map(([, sec]) => hit(`fl:${name}:${subject}:${sec}`, sec)));
  let wait = 0;
  ws.forEach(([n, sec], i) => {
    if (used[i] > n) wait = Math.max(wait, left(sec));
    // бюджет на весь сервер: предупредить один раз, когда израсходовано 80%
    else if (subject === '*' && used[i] === Math.ceil(n * 0.8)) console.warn(`flood: ${name} — ${used[i]} of ${n} per ${sec}s used (${envName(name)})`);
  });
  if (wait && subject === '*') console.warn(`flood: ${name} budget exhausted, refusing for ${wait}s (${envName(name)})`);
  return wait;
}

/** Засчитать действие; превышен лимит — flood с retryAfter. */
export async function limit(name: LimitName, subject: string | number): Promise<void> {
  const wait = await count(name, subject);
  if (wait) throw new DomainError('flood', name, wait);
}

/** Действие без ответа («печатает…»): превышен лимит — false, вызвавший молча пропускает. */
export async function allowed(name: LimitName, subject: string | number): Promise<boolean> {
  return (await count(name, subject)) === 0;
}

// коды стран: однозначные (1, 7) и двузначные (зоны 2–9 по E.164); остальные — трёхзначные
const CC2 = new Set([20, 27, 30, 31, 32, 33, 34, 36, 39, 40, 41, 43, 44, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56, 57, 58,
  60, 61, 62, 63, 64, 65, 66, 81, 82, 84, 86, 90, 91, 92, 93, 94, 95, 98]);

/** Код страны номера «+…» ('+7', '+44', '+380'); не номер — null. */
export function phonePrefix(login: string): string | null {
  const m = /^\+([0-9]{7,15})$/.exec(login);
  if (!m) return null;
  const d = m[1];
  if (d[0] === '1' || d[0] === '7') return '+' + d[0];
  return '+' + (CC2.has(Number(d.slice(0, 2))) ? d.slice(0, 2) : d.slice(0, 3));
}
