import type { SessionInfo } from '@relay/protocol';
import type { Ops } from './ops';
import type { Action } from './types';

/**
 * Активные сеансы: в журнал не пишутся и в IDB не хранятся — список берётся с сервера по запросу (listSessions).
 * Завершение — через очередь ops; пока операция не ушла, вид списка выводится из ответа сервера + очереди (sessionsView).
 */
export const OP_SESSION = 'session:';
export const sessionKey = (id: number) => OP_SESSION + id;
export const OP_SESSIONS_OTHERS = 'sessions:others';
/** Срок автозавершения — в настройках аккаунта (settings.ts), правки схлопываются. */
export const OP_SESSIONS_TTL = 'sessionsTtl';

export const isSessionOp = (key: string): boolean => key.startsWith(OP_SESSION) || key === OP_SESSIONS_OTHERS;

/** Список, как его видит интерфейс: без сеансов, завершение которых ещё в очереди. */
export function sessionsView(list: readonly SessionInfo[], keys: readonly string[]): SessionInfo[] {
  if (!keys.length) return [...list];
  const set = new Set(keys);
  const others = set.has(OP_SESSIONS_OTHERS);
  return list.filter((s) => s.current || (!others && !set.has(sessionKey(s.id))));
}

export type SessionsAction = Extract<Action, { type: 'listSessions' | 'terminateSession' | 'terminateOtherSessions' }>;
export type SessionsList = { sessions: SessionInfo[] } | { offline: true };

export interface SessionsHost {
  ops: Ops;
  online(): boolean;
  http<T>(path: string): Promise<T>;
}

export class Sessions {
  constructor(private h: SessionsHost) {}

  async act(a: SessionsAction): Promise<unknown> {
    switch (a.type) {
      case 'listSessions': {
        if (!this.h.online()) return { offline: true } satisfies SessionsList;
        try {
          const list = await this.h.http<SessionInfo[]>('/sessions');
          return { sessions: sessionsView(list, this.h.ops.list.map((o) => o.key)) } satisfies SessionsList;
        } catch { return { offline: true } satisfies SessionsList; }
      }
      case 'terminateSession':
        await this.h.ops.enqueue({ key: sessionKey(a.id), method: 'DELETE', path: `/sessions/${a.id}` });
        return null;
      case 'terminateOtherSessions':
        await this.h.ops.enqueue({ key: OP_SESSIONS_OTHERS, method: 'DELETE', path: '/sessions?others=1' });
        return null;
    }
  }
}
