/**
 * Исходящие коды без настоящей доставки (почта восстановления пароля). В dev их видно на /dev/codes,
 * в проде — только строка в логе без самого кода: почтового шлюза в Relay пока нет.
 */
export interface OutboxItem { at: string; to: string; kind: 'recovery'; code: string }

const items: OutboxItem[] = [];
const MAX = 50;

export function deliver(item: Omit<OutboxItem, 'at'>): void {
  if (process.env.DEV_LOGIN === '1') {
    items.unshift({ ...item, at: new Date().toISOString() });
    items.length = Math.min(items.length, MAX);
  } else {
    console.warn(`outbox: ${item.kind} code for ${item.to.replace(/(.).*@/, '$1…@')} — no mail gateway configured`);
  }
}

export function devOutbox(): OutboxItem[] { return items.slice(); }
export function clearOutbox(): void { items.length = 0; }
