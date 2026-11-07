import { sql } from '../db';
import { codeChannel, deliverExternal, queued } from './codeDelivery';

/**
 * Исходящие коды почты восстановления пароля. Отправляет воркер (задача mail.recovery) каналом CODE_DELIVERY
 * (codeDelivery.ts): в dev письма лежат в таблице dev_mail и видны на /dev/codes из любого процесса, log — строка
 * в логе, telegram — владельцу в бот; без канала — только строка в логе без самого кода: почтового шлюза пока нет.
 */
export interface OutboxItem { at: string; to: string; kind: 'recovery'; code: string }

const MAX = 50;

export async function deliver(item: Omit<OutboxItem, 'at'> & { expiresAt?: string }): Promise<void> {
  const channel = codeChannel();
  if (channel === 'dev') {
    await sql`insert into dev_mail (to_addr, kind, code) values (${item.to}, ${item.kind}, ${item.code})`;
    await sql`delete from dev_mail where id not in (select id from dev_mail order by id desc limit ${MAX})`;
  } else if (channel === 'log') {
    console.log(`${item.kind} code for ${item.to}: ${item.code}`);
  } else if (queued(channel)) {
    await deliverExternal(item);
  } else {
    console.warn(`outbox: ${item.kind} code for ${item.to.replace(/(.).*@/, '$1…@')} — no mail gateway configured`);
  }
}

export async function devOutbox(): Promise<OutboxItem[]> {
  const rows = await sql`select at, to_addr, kind, code from dev_mail order by id desc limit ${MAX}`;
  return rows.map((r) => ({ at: new Date(r.at as string).toISOString(), to: r.to_addr as string, kind: r.kind as 'recovery', code: r.code as string }));
}

export async function clearOutbox(): Promise<void> {
  await sql`delete from dev_mail`;
}
