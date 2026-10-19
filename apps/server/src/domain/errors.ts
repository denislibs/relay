import type { ErrorCode } from '@relay/protocol';

export class DomainError extends Error {
  /** retryAfter — секунд до повтора (лимиты, flood): HTTP отдаёт его в Retry-After и в теле ответа. */
  constructor(public code: ErrorCode, message: string = code, public retryAfter?: number) {
    super(message);
  }
}
