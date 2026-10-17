// Конфиденциальность без DOM: подписи правил, тексты экранов, кандидаты для выбора людей, сохранение исключений.
import type { PrivacyMode, PrivacyRule } from '@relay/protocol';
import type { Item } from '@relay/sync-engine/src/types';

/** Правила, которые настраиваются со страницы «Конфиденциальность» (phoneDiscovery — внутри экрана номера). */
export type RuleKey = 'phone' | 'lastSeen' | 'bio' | 'birthday';
export const RULE_KEYS: RuleKey[] = ['phone', 'lastSeen', 'bio', 'birthday'];
export const isRuleKey = (k: string): k is RuleKey => (RULE_KEYS as string[]).includes(k);

export const MODE_LABEL: Record<PrivacyMode, string> = { everyone: 'Все', contacts: 'Мои контакты', nobody: 'Никто' };

/** Строка на странице «Конфиденциальность» и заголовок экрана правила. */
export const RULE_TITLE: Record<RuleKey, string> = {
  phone: 'Номер телефона',
  lastSeen: 'Последний визит и «в сети»',
  bio: 'О себе',
  birthday: 'День рождения',
};

/** Заголовок секции с радио на экране правила. */
export const RULE_QUESTION: Record<RuleKey, string> = {
  phone: 'Кто видит мой номер телефона',
  lastSeen: 'Кто видит время моего последнего визита',
  bio: 'Кто видит информацию «О себе»',
  birthday: 'Кто видит мой день рождения',
};

const WHAT: Record<RuleKey, [string, string]> = {
  // [что, видят/видит] — подпись под радио собирается из них
  phone: ['Ваш номер', 'видят'],
  lastSeen: ['Время вашего последнего визита и статус «в сети»', 'видят'],
  bio: ['Информацию «О себе»', 'видят'],
  birthday: ['Ваш день рождения', 'видят'],
};

/** Подпись под радио: меняется по выбору. */
export function ruleCaption(key: RuleKey, mode: PrivacyMode): string {
  const [what, verb] = WHAT[key];
  const base = mode === 'everyone' ? `${what} ${verb} все, кто с вами общается.`
    : mode === 'contacts' ? `${what} ${verb} только ваши контакты.`
      : `${what} не видит никто, кроме людей из исключений.`;
  // взаимность: кто скрывает своё время, не видит и чужое
  return key === 'lastSeen' && mode !== 'everyone'
    ? base + ' Вы тоже не увидите точное время визита тех, кому не показываете своё, — вместо него будет «был(а) недавно».'
    : base;
}

export const DISCOVERY_TITLE = 'Кто найдёт меня по номеру';
export function discoveryCaption(mode: PrivacyMode): string {
  return mode === 'contacts' ? 'Найти вас по номеру телефона смогут только ваши контакты.' : 'Найти вас по номеру телефона может любой, кто его знает.';
}

export const EXCEPTIONS_FOOTER = 'Исключения действуют поверх выбранного варианта: «Никогда не показывать» главнее.';

/** Подпись строки правила: «Мои контакты (−2, +1)» — исключения, которые при этом режиме что-то значат. */
export function ruleSubtitle(r: PrivacyRule): string {
  const parts: string[] = [];
  if (r.mode !== 'nobody' && r.deny.length) parts.push('−' + r.deny.length);
  if (r.mode !== 'everyone' && r.allow.length) parts.push('+' + r.allow.length);
  return MODE_LABEL[r.mode] + (parts.length ? ` (${parts.join(', ')})` : '');
}

/** «N пользователей» / «Добавить пользователей». */
export function peopleCount(n: number): string {
  if (!n) return 'Добавить пользователей';
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? 'пользователь' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'пользователя' : 'пользователей';
  return `${n} ${w}`;
}

export interface Person { id: number; name: string; about: string }

/**
 * Кого можно выбрать: контакты, собеседники по личным чатам и уже выбранные (даже если их больше нигде нет).
 * Без повторов и без себя; контактное имя главнее названия чата.
 */
export function candidates(contacts: Item[], chats: Item[], me: number, known: number[] = [], extra: Item[] = []): Person[] {
  const out = new Map<number, Person>();
  const about = (x: Item) => (x.username ? '@' + String(x.username) : x.phone ? String(x.phone) : '');
  for (const c of contacts) if (typeof c.userId === 'number' && c.userId !== me) out.set(c.userId, { id: c.userId, name: String(c.name || c.publicName || ''), about: about(c) });
  for (const c of chats) {
    const id = c.peerId as number | null;
    if (c.kind !== 'direct' || typeof id !== 'number' || id === me || out.has(id)) continue;
    out.set(id, { id, name: String(c.title || ''), about: '' });
  }
  for (const x of extra) if (typeof x.userId === 'number' && !out.has(x.userId) && x.userId !== me) out.set(x.userId, { id: x.userId, name: String(x.name || ''), about: about(x) });
  for (const id of known) if (!out.has(id) && id !== me) out.set(id, { id, name: 'Пользователь', about: '' });
  return [...out.values()].filter((p) => p.name).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Новое правило после выбора людей для списка which: выбранные уходят из противоположного списка. */
export function withPeople(r: PrivacyRule, which: 'allow' | 'deny', ids: number[]): PrivacyRule {
  const set = new Set(ids);
  const other = which === 'allow' ? 'deny' : 'allow';
  return { mode: r.mode, [which]: [...set], [other]: r[other].filter((x) => !set.has(x)) } as unknown as PrivacyRule;
}

/** Набор людей изменился (порядок не важен). */
export function samePeople(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** Ключ правила из пути settings/privacy/rule/:key[/allow|deny]. */
export function parseRulePath(path: string): { key: RuleKey; list: 'allow' | 'deny' | null } | null {
  const m = /^settings\/privacy\/rule\/([^/]+)(?:\/(allow|deny))?$/.exec(path);
  if (!m || !isRuleKey(m[1])) return null;
  return { key: m[1], list: (m[2] as 'allow' | 'deny' | undefined) ?? null };
}
