import { migrate } from '../src/migrate';
import { initPeerKeys } from '../src/crypto/peerKey';

// лимиты flood.ts в тестах выключены (тесты создают десятки чатов и сообщений подряд); тесты лимитов включают их
// сами — setLimit сильнее переменной окружения (test/flood.test.ts)
process.env.RELAY_LIMITS ??= 'off';

await migrate();
await initPeerKeys();
