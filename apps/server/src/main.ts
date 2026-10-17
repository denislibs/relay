import { createServer } from './http';
import { startRealtime } from './realtime';
import { sweepInactive } from './domain/sessions';

const server = createServer({ port: Number(process.env.PORT ?? 3000) });
await startRealtime(server);
// автозавершение неактивных сеансов — раз в час (и при каждом входе, см. /dev/login)
const sweep = () => { sweepInactive().catch((e) => console.error('sessions sweep:', e)); };
sweep();
setInterval(sweep, 3600_000).unref();
console.log(`relay server on :${server.port}`);
