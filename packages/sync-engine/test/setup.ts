import 'fake-indexeddb/auto';
import { migrate } from '../../../apps/server/src/migrate';

// лимиты flood.ts сервера в тестах выключены; тест FLOOD_WAIT (outbox.test.ts) включает свой через setLimit
process.env.RELAY_LIMITS ??= 'off';

await migrate();
