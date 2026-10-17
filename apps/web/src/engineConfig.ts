// Конфиг движка для вкладки. Хост берёт конфиг первого hello, поэтому второй клиент (settingsData.ts)
// обязан слать ровно тот же, что data.ts. data.ts пока строит его у себя — совпадение стережёт engineConfig.test.ts.
import type { EngineConfig } from '@relay/sync-engine/src/types';
import type { Me } from './global';

export function engineConfig(me: Me): EngineConfig {
  // порция ленты — два экрана сообщений (строка-бабл ≈ 40 px), не меньше 30
  const FEED_PAGE = Math.max(30, Math.ceil(innerHeight / 40) * 2);
  return {
    userId: me.userId,
    dbName: 'relay-' + me.userId,
    httpBase: location.origin,
    wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
    // страница диалогов — два экрана строк, не меньше 20
    dialogsPage: Math.max(20, Math.ceil(innerHeight / 72) * 2),
    historyPage: FEED_PAGE,
  };
}
