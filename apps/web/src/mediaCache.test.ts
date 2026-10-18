import { describe, expect, test } from 'bun:test';
import { DEFAULT_POLICY, isMediaRequest, loadPolicy, MAX_ITEM, savePolicy, serveMedia, sweepMedia } from './mediaCache';

/** Cache Storage в памяти: ключ — путь. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const keyOf = (k: RequestInfo) => (typeof k === 'string' ? k : new URL(k.url).pathname);
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (k: RequestInfo) => m.get(keyOf(k))?.clone(),
      put: async (k: RequestInfo, r: Response) => { m.set(keyOf(k), r); },
      delete: async (k: RequestInfo) => m.delete(keyOf(k)),
      keys: async () => [...m.keys()].map((k) => new Request('http://x' + k)),
    } as unknown as Cache;
  };
  return { open, stores } as unknown as Pick<CacheStorage, 'open'> & { stores: typeof stores };
}

const ID = '/files/0b6f8c1e-3f2a-4c55-9d7e-1a2b3c4d5e6f';
const req = (path = ID, init?: RequestInit) => new Request('http://app' + path, init);
const ok = (bytes: number, type = 'image/png') => new Response(new Uint8Array(bytes), { headers: { 'content-type': type, 'content-length': String(bytes) } });

describe('isMediaRequest', () => {
  test('only plain GETs of /files/<uuid> on our origin', () => {
    expect(isMediaRequest(req(), 'http://app')).toBe(true);
    expect(isMediaRequest(req(ID + '?download=1'), 'http://app')).toBe(false);
    expect(isMediaRequest(req(ID, { headers: { range: 'bytes=0-1' } }), 'http://app')).toBe(false);
    expect(isMediaRequest(req(ID, { method: 'HEAD' }), 'http://app')).toBe(false);
    expect(isMediaRequest(req('/files/../me'), 'http://app')).toBe(false);
    expect(isMediaRequest(req(), 'http://other')).toBe(false);
  });
});

describe('serveMedia', () => {
  test('miss goes to the network and stores a stamped copy; the next hit needs no network', async () => {
    const c = fakeCaches();
    let calls = 0;
    const net = async () => { calls++; return ok(100); };
    const first = await serveMedia(c, req(), net, 1000);
    await first.background;
    expect(first.stored).toBe(true);
    expect((await first.response.arrayBuffer()).byteLength).toBe(100);
    const second = await serveMedia(c, req(), net, 2000);
    expect(calls).toBe(1);
    expect(second.response.headers.get('content-type')).toBe('image/png');
    expect((await second.response.arrayBuffer()).byteLength).toBe(100);
  });

  test('errors, unknown length and oversized files are not cached', async () => {
    const c = fakeCaches();
    for (const r of [new Response('no', { status: 404 }), new Response('x'), ok(MAX_ITEM + 1)]) {
      const out = await serveMedia(c, req(), async () => r, 1);
      await out.background;
      expect(out.stored).toBe(false);
    }
    expect(c.stores.get('relay-media')?.size ?? 0).toBe(0);
  });

  test('access time is refreshed at most once a day', async () => {
    const c = fakeCaches();
    await (await serveMedia(c, req(), async () => ok(10), 0)).background;
    const day = 24 * 3600_000;
    expect((await serveMedia(c, req(), async () => ok(10), day - 1)).background).toBeNull();
    const later = await serveMedia(c, req(), async () => ok(10), day + 5);
    await later.background;
    const stored = c.stores.get('relay-media')!.get(ID)!;
    expect(stored.headers.get('x-relay-used')).toBe(String(day + 5));
    expect(stored.headers.get('x-relay-saved')).toBe('0');
  });
});

describe('sweepMedia', () => {
  const put = async (c: ReturnType<typeof fakeCaches>, n: number, size: number, at: number) =>
    (await serveMedia(c, req(`/files/00000000-0000-0000-0000-${String(n).padStart(12, '0')}`), async () => ok(size), at)).background;

  test('drops entries not used for keepDays, then the least recently used until under maxMb', async () => {
    const c = fakeCaches();
    const day = 24 * 3600_000, mb = 1024 * 1024;
    await put(c, 1, mb, 0);                // старое: уйдёт по сроку
    await put(c, 2, 2 * mb, 9 * day);      // давно нужное: уйдёт по размеру
    await put(c, 3, 2 * mb, 10 * day);
    const res = await sweepMedia(c, { keepDays: 7, maxMb: 3 }, 10 * day);
    expect(res).toEqual({ removed: 2, bytes: 2 * mb });
    expect([...c.stores.get('relay-media')!.keys()]).toEqual(['/files/00000000-0000-0000-0000-000000000003']);
  });

  test('zero means no limit', async () => {
    const c = fakeCaches();
    await put(c, 1, 10, 0);
    expect(await sweepMedia(c, { keepDays: 0, maxMb: 0 }, 1e13)).toEqual({ removed: 0, bytes: 10 });
  });
});

test('policy survives in Cache Storage; garbage falls back to defaults', async () => {
  const c = fakeCaches();
  expect(await loadPolicy(c)).toEqual(DEFAULT_POLICY);
  await savePolicy(c, { keepDays: 7, maxMb: 500 });
  expect(await loadPolicy(c)).toEqual({ keepDays: 7, maxMb: 500 });
});
