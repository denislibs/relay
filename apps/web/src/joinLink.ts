// Что открывает ссылка /+токен или /@имя (как t.me в Telegram). Чистые правила без DOM — карточка в ui/group/JoinLink.tsx,
// тесты в joinLink.test.ts.

/** open — уже участник: сразу в чат; preview — публичный канал по @имени: его лента без подписки; card — карточка «Вступить». */
export type JoinAction = 'open' | 'preview' | 'card';

export function joinAction(key: string, p: { kind: 'group' | 'channel'; member: boolean }): JoinAction {
  if (p.member) return 'open';
  return key.startsWith('@') && p.kind === 'channel' ? 'preview' : 'card';
}

/** Карточку показываем сразу только для приглашения (+токен); @имя — сначала узнать, что это: канал и человек карточки не имеют. */
export const showCardAt = (key: string | null, resolved: boolean): boolean => !!key && (!key.startsWith('@') || resolved);
