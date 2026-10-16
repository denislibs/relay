import type { ErrorCode } from '@relay/protocol';

export class DomainError extends Error {
  constructor(public code: ErrorCode, message: string = code) {
    super(message);
  }
}
