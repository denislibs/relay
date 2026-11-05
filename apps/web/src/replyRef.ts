import type { ReplyQuote } from '@relay/protocol';

/** На что отвечает отправка: id сообщения или id с цитатой его части (выделение → «Цитировать»). */
export type ReplyRef = number | { id: number; quote: ReplyQuote } | null;

/** Поля действия движка. */
export const replyArgs = (r: ReplyRef | undefined): { replyToId: number | null; replyQuote?: ReplyQuote } =>
  r != null && typeof r === 'object' ? { replyToId: r.id, replyQuote: r.quote } : { replyToId: r ?? null };
