import { afterAll, expect, test } from 'bun:test';
import { createServer } from '../src/http';

const server = createServer({ port: 0 });
afterAll(() => server.stop(true));

test('GET /health answers ok', async () => {
  const res = await fetch(`http://localhost:${server.port}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
