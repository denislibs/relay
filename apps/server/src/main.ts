import { createServer } from './http';
import { startRealtime } from './realtime';

const server = createServer({ port: Number(process.env.PORT ?? 3000) });
await startRealtime(server);
console.log(`relay server on :${server.port}`);
