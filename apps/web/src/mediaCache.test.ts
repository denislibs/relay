import { describe, expect, test } from 'bun:test';
import { memoryAttachmentIndex } from './attachmentsOnDevice';
import {
  CACHE_ATTACHMENTS_AUTO, CACHE_ATTACHMENTS_SAVED, clearAllAttachments, DEFAULT_POLICY, fetchMedia, findOnDevice, isMediaRequest,
  loadPolicy, MAX_AUTO_FILE, migrateLegacyCaches, putAttachment, savePolicy, serveMedia, serveVideoRange, sweepAuto, type AttachmentStore,
} from './mediaCache';

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
  return { open, has: async (n: string) => stores.has(n), delete: async (n: string) => stores.delete(n), stores } as unknown as Pick<CacheStorage, 'open' | 'has' | 'delete'> & { stores: typeof stores };
}

/** Хранилище для теста: кэши и индекс в памяти, оценка места — по запросу, changed считает оповещения. */
function fakeStore(space?: { quota: number; usage: () => number }) {
  const caches = fakeCaches();
  const index = memoryAttachmentIndex();
  const s = { caches, index, changes: 0, estimate: space ? async () => ({ quota: space.quota, usage: space.usage() }) : undefined } as AttachmentStore & { caches: typeof caches; index: typeof index; changes: number };
  s.changed = () => { s.changes++; };
  return s;
}
const keys = (s: ReturnType<typeof fakeStore>, cache: string) => [...(s.caches.stores.get(cache)?.keys() ?? [])];
const fid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const blob = (size: number, type = 'image/png') => new Blob([new Uint8Array(size)], { type });

const ID = '/files/0b6f8c1e-3f2a-4c55-9d7e-1a2b3c4d5e6f';
const req = (path = ID, init?: RequestInit) => new Request('http://app' + path, init);
const ok = (bytes: number, type = 'image/png') => new Response(new Uint8Array(bytes), { headers: { 'content-type': type, 'content-length': String(bytes) } });

describe('isMediaRequest', () => {
  test('only plain GETs of /files/<uuid> on our origin', () => {
    expect(isMediaRequest(req(), 'http://app')).toBe(true);
    expect(isMediaRequest(req(ID + '/preview'), 'http://app')).toBe(true);   // копии видео — тоже через SW
    expect(isMediaRequest(req(ID + '/720'), 'http://app')).toBe(true);
    expect(isMediaRequest(req(ID + '/1080'), 'http://app')).toBe(false);
    expect(isMediaRequest(req(ID + '?download=1'), 'http://app')).toBe(false);
    expect(isMediaRequest(req(ID, { headers: { range: 'bytes=0-1' } }), 'http://app')).toBe(false);
    expect(isMediaRequest(req(ID, { method: 'HEAD' }), 'http://app')).toBe(false);
    expect(isMediaRequest(req('/files/../me'), 'http://app')).toBe(false);
    expect(isMediaRequest(req(), 'http://other')).toBe(false);
  });
});

describe('fetchMedia', () => {
  test('asks in cors mode (the 302 to the storage stays readable); falls back to the original request', async () => {
    const seen: Request[] = [];
    const res = await fetchMedia(req(ID, { mode: 'no-cors' }), async (r) => { seen.push(r); return ok(3); });
    expect(res.status).toBe(200);
    // credentials: 'same-origin' Bun не хранит в Request (всегда include) — проверяем режим и редирект
    expect(seen.map((r) => [new URL(r.url).pathname, r.mode, r.redirect])).toEqual([[ID, 'cors', 'follow']]);
    const tries: Request[] = [];
    const orig = req(ID);
    const back = await fetchMedia(orig, async (r) => { tries.push(r); if (tries.length === 1) throw new TypeError('CORS'); return ok(2); });
    expect(back.status).toBe(200);
    expect(tries[1]).toBe(orig);
  });
});

describe('serveMedia', () => {
  test('miss: network, then the file goes to auto-evictable with a plain response and an index row; the next hit needs no network', async () => {
    const s = fakeStore();
    let calls = 0;
    const net = async () => { calls++; return ok(100); };
    const first = await serveMedia(s, req(), net, 1000);
    await first.background;
    expect(first.stored).toBe(true);
    expect((await first.response.arrayBuffer()).byteLength).toBe(100);
    const cached = s.caches.stores.get(CACHE_ATTACHMENTS_AUTO)!.get(ID)!;
    // в ответе только тип и длина — служебное в индексе
    expect([...cached.headers.keys()].sort()).toEqual(['content-length', 'content-type']);
    expect(s.index.rows.get(ID.slice(7))).toEqual({ fileId: ID.slice(7), bucket: 'auto-evictable', sizeBytes: 100, mimeType: 'image/png', storedAt: 1000, lastOpenedAt: 1000 });
    const second = await serveMedia(s, req(), net, 2000);
    expect(calls).toBe(1);
    expect(second.response.headers.get('content-type')).toBe('image/png');
    expect((await second.response.arrayBuffer()).byteLength).toBe(100);
  });

  test('errors, unknown length and oversized files are not kept', async () => {
    const s = fakeStore();
    for (const r of [new Response('no', { status: 404 }), new Response('x'), ok(MAX_AUTO_FILE + 1)]) {
      const out = await serveMedia(s, req(), async () => r, 1);
      await out.background;
      expect(out.stored).toBe(false);
    }
    expect(keys(s, CACHE_ATTACHMENTS_AUTO)).toEqual([]);
    expect(s.index.rows.size).toBe(0);
  });

  test('"opened" is a small index write at most once an hour — the file itself is never rewritten', async () => {
    const s = fakeStore();
    await (await serveMedia(s, req(), async () => ok(10), 0)).background;
    const file = s.caches.stores.get(CACHE_ATTACHMENTS_AUTO)!.get(ID);
    const hour = 3600_000;
    expect((await serveMedia(s, req(), async () => ok(10), hour - 1)).background).toBeNull();
    await (await serveMedia(s, req(), async () => ok(10), hour + 5)).background;
    expect(s.index.rows.get(ID.slice(7))).toMatchObject({ storedAt: 0, lastOpenedAt: hour + 5 });
    expect(s.caches.stores.get(CACHE_ATTACHMENTS_AUTO)!.get(ID)).toBe(file);
  });

  test('index row without a file (the browser evicted it) is forgotten and the file is fetched again', async () => {
    const s = fakeStore();
    await (await serveMedia(s, req(), async () => ok(10), 0)).background;
    s.caches.stores.get(CACHE_ATTACHMENTS_AUTO)!.clear();
    expect(await findOnDevice(s, ID.slice(7))).toBeNull();
    expect(s.index.rows.size).toBe(0);
  });
});

describe('two buckets', () => {
  test('saving with the button moves a file from auto-evictable to saved-by-user; auto never demotes it back', async () => {
    const s = fakeStore();
    await putAttachment(s, fid(1), blob(10), 'auto-evictable', 1);
    await putAttachment(s, fid(1), blob(10), 'saved-by-user', 2);
    expect(keys(s, CACHE_ATTACHMENTS_AUTO)).toEqual([]);
    expect(keys(s, CACHE_ATTACHMENTS_SAVED)).toEqual([`/files/${fid(1)}`]);
    expect(s.index.rows.get(fid(1))).toMatchObject({ bucket: 'saved-by-user', storedAt: 1, lastOpenedAt: 2 });
    await putAttachment(s, fid(1), blob(10), 'auto-evictable', 3);
    expect(s.index.rows.get(fid(1))!.bucket).toBe('saved-by-user');
    expect(keys(s, CACHE_ATTACHMENTS_AUTO)).toEqual([]);
  });

  test('clearAllAttachments wipes both buckets and the index', async () => {
    const s = fakeStore();
    await putAttachment(s, fid(1), blob(10), 'auto-evictable');
    await putAttachment(s, fid(2), blob(10), 'saved-by-user');
    await clearAllAttachments(s);
    expect(s.caches.stores.size).toBe(0);
    expect(s.index.rows.size).toBe(0);
  });
});

describe('sweepAuto', () => {
  const day = 24 * 3600_000, mb = 1024 * 1024;

  test('drops auto files not opened for keepAutoDays, then the least recently opened until under maxAutoMb; saved files stay', async () => {
    const s = fakeStore();
    await putAttachment(s, fid(1), blob(mb), 'auto-evictable', 0);            // старое: уйдёт по сроку
    await putAttachment(s, fid(2), blob(2 * mb), 'auto-evictable', 9 * day);  // давно открытое: уйдёт по размеру
    await putAttachment(s, fid(3), blob(2 * mb), 'auto-evictable', 10 * day);
    await putAttachment(s, fid(4), blob(5 * mb), 'saved-by-user', 0);         // ваше: ни срок, ни лимит не трогают
    const res = await sweepAuto(s, { keepAutoDays: 7, maxAutoMb: 3 }, 10 * day);
    expect(res).toEqual({ removed: 2, autoBytes: 2 * mb });
    expect(keys(s, CACHE_ATTACHMENTS_AUTO)).toEqual([`/files/${fid(3)}`]);
    expect(keys(s, CACHE_ATTACHMENTS_SAVED)).toEqual([`/files/${fid(4)}`]);
    expect([...s.index.rows.keys()].sort()).toEqual([fid(3), fid(4)]);
  });

  test('zero means no limit', async () => {
    const s = fakeStore();
    await putAttachment(s, fid(1), blob(10), 'auto-evictable', 0);
    expect(await sweepAuto(s, { keepAutoDays: 0, maxAutoMb: 0 }, 1e13)).toEqual({ removed: 0, autoBytes: 10 });
  });

  test('reconciles: rows without files are dropped, files without rows get a row', async () => {
    const s = fakeStore();
    await putAttachment(s, fid(1), blob(10), 'auto-evictable', 0);
    await putAttachment(s, fid(2), blob(20), 'saved-by-user', 0);
    s.caches.stores.get(CACHE_ATTACHMENTS_AUTO)!.delete(`/files/${fid(1)}`);   // файл вытеснен, запись осталась
    s.index.rows.delete(fid(2));                                               // запись оборвалась, файл остался
    await sweepAuto(s, DEFAULT_POLICY, 5);
    expect([...s.index.rows.values()]).toEqual([{ fileId: fid(2), bucket: 'saved-by-user', sizeBytes: 20, mimeType: 'image/png', storedAt: 5, lastOpenedAt: 5 }]);
  });
});

describe('room on the device', () => {
  const mb = 1024 * 1024;
  test('when free space runs short, auto files are evicted (oldest opened first) before writing; saved files are not', async () => {
    let usage = 0;
    const s = fakeStore({ quota: 1000 * mb, usage: () => usage });
    await putAttachment(s, fid(1), blob(10), 'auto-evictable', 1);
    await putAttachment(s, fid(2), blob(10), 'auto-evictable', 2);
    await putAttachment(s, fid(3), blob(10), 'saved-by-user', 0);
    s.index.rows.get(fid(1))!.sizeBytes = 100 * mb;   // индекс говорит, сколько освободит удаление
    s.index.rows.get(fid(2))!.sizeBytes = 100 * mb;
    s.index.rows.get(fid(3))!.sizeBytes = 500 * mb;
    usage = 750 * mb;                                  // свободно 250 МБ; под файл 10 МБ нужно 10 + 200 (пятая часть квоты) — хватает
    expect(await putAttachment(s, fid(4), blob(10), 'auto-evictable', 3)).toBe(true);
    expect(s.index.rows.has(fid(1))).toBe(true);
    usage = 900 * mb;                                  // свободно 100: нужно освободить ~110 — уходят оба auto, ваше остаётся
    expect(await putAttachment(s, fid(5), blob(10), 'auto-evictable', 4)).toBe(true);
    expect(s.index.rows.has(fid(1))).toBe(false);
    expect(s.index.rows.has(fid(2))).toBe(false);
    expect(s.index.rows.has(fid(3))).toBe(true);
  });

  test('if even evicting all auto files is not enough, the file is not kept', async () => {
    const s = fakeStore({ quota: 1000 * mb, usage: () => 999 * mb });
    expect(await putAttachment(s, fid(1), blob(10), 'saved-by-user')).toBe(false);
    expect(s.index.rows.size).toBe(0);
  });

  test('a quota error frees auto files and retries once', async () => {
    const s = fakeStore();
    await putAttachment(s, fid(1), blob(10), 'auto-evictable', 1);
    const open = s.caches.open;
    let tries = 0;
    s.caches.open = (async (n: string) => {
      const c = await open(n);
      if (n !== CACHE_ATTACHMENTS_SAVED) return c;
      return { ...c, put: async (k: RequestInfo, r: Response) => { if (++tries === 1) throw new DOMException('full', 'QuotaExceededError'); return c.put(k, r); } } as unknown as Cache;
    }) as typeof s.caches.open;
    expect(await putAttachment(s, fid(2), blob(10), 'saved-by-user', 2)).toBe(true);
    expect(tries).toBe(2);
    expect(s.index.rows.has(fid(1))).toBe(false);
    expect(keys(s, CACHE_ATTACHMENTS_SAVED)).toEqual([`/files/${fid(2)}`]);
  });
});

test('policy lives in the index; garbage falls back to defaults', async () => {
  const s = fakeStore();
  expect(await loadPolicy(s)).toEqual(DEFAULT_POLICY);
  await savePolicy(s, { keepAutoDays: 7, maxAutoMb: 500 });
  expect(await loadPolicy(s)).toEqual({ keepAutoDays: 7, maxAutoMb: 500 });
  await s.index.setPolicy({ keepAutoDays: -1, maxAutoMb: NaN } as never);
  expect(await loadPolicy(s)).toEqual(DEFAULT_POLICY);
});

test('legacy relay-media / relay-meta move into auto-evictable with their times and policy, then disappear', async () => {
  const s = fakeStore();
  const old = await s.caches.open('relay-media');
  await old.put(`/files/${fid(1)}`, new Response(new Uint8Array(7), { headers: { 'content-type': 'image/jpeg', 'content-length': '7', 'x-relay-saved': '11', 'x-relay-used': '22' } }));
  const meta = await s.caches.open('relay-meta');
  await meta.put('/__relay/media-policy', new Response(JSON.stringify({ keepDays: 3, maxMb: 200 })));
  expect(await migrateLegacyCaches(s, 99)).toBe(1);
  expect(s.caches.stores.has('relay-media')).toBe(false);
  expect(s.caches.stores.has('relay-meta')).toBe(false);
  expect(keys(s, CACHE_ATTACHMENTS_AUTO)).toEqual([`/files/${fid(1)}`]);
  expect(s.index.rows.get(fid(1))).toEqual({ fileId: fid(1), bucket: 'auto-evictable', sizeBytes: 7, mimeType: 'image/jpeg', storedAt: 11, lastOpenedAt: 22 });
  expect(await loadPolicy(s)).toEqual({ keepAutoDays: 3, maxAutoMb: 200 });
});

describe('serveVideoRange — the start of a video in aligned chunks', () => {
  const VID = '0b6f8c1e-3f2a-4c55-9d7e-1a2b3c4d5e6f';
  const FULL = 5 * 1024 * 1024;
  const K = 512 * 1024;
  const file = new Uint8Array(FULL).map((_, i) => i % 251);
  const rangeReq = (range: string, path = `/files/${VID}/720`) => new Request('http://app' + path, { headers: { range } });
  /** Хранилище: отдаёт кусок по Range с Content-Range (как S3 за proxy, который открывает его по CORS). */
  const storage = (opts: { hideSize?: boolean } = {}) => {
    const asked: string[] = [];
    const chunk = async (_url: string, range: string) => {
      asked.push(range);
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
      const end = Math.min(Number(b), FULL - 1);
      return new Response(file.slice(Number(a), end + 1), { status: 206, headers: { 'content-type': 'video/mp4', ...(opts.hideSize ? {} : { 'content-range': `bytes ${a}-${end}/${FULL}` }) } });
    };
    return { asked, chunk };
  };
  const passed: string[] = [];
  const pass = async (r: Request) => { passed.push(r.headers.get('range')!); return new Response('net', { status: 206 }); };

  test('a range in the first 2 MB: one aligned chunk from the network, an honest 206 to the player, the chunk kept with the full size', async () => {
    const s = fakeStore(), st = storage();
    const out = await serveVideoRange(s, rangeReq('bytes=600000-'), pass, st.chunk, 7);
    await out.background;
    expect(st.asked).toEqual([`bytes=${K}-${2 * K - 1}`]);
    expect(out.response.status).toBe(206);
    expect(out.response.headers.get('content-range')).toBe(`bytes 600000-${2 * K - 1}/${FULL}`);
    expect(new Uint8Array(await out.response.arrayBuffer())).toEqual(file.slice(600000, 2 * K));
    expect(s.index.rows.get(`${VID}/720@${K}`)).toEqual({ fileId: `${VID}/720@${K}`, bucket: 'auto-evictable', sizeBytes: K, mimeType: 'video/mp4', storedAt: 7, lastOpenedAt: 7, chunkOf: { offset: K, fullSize: FULL } });
  });

  test('the same chunk again comes from the device — no network, also offline', async () => {
    const s = fakeStore(), st = storage();
    await (await serveVideoRange(s, rangeReq('bytes=0-'), pass, st.chunk, 1)).background;
    const offline = async () => { throw new TypeError('offline'); };
    const again = await serveVideoRange(s, rangeReq('bytes=100-199'), pass, offline, 2);
    expect(again.response.headers.get('content-range')).toBe(`bytes 100-199/${FULL}`);
    expect(new Uint8Array(await again.response.arrayBuffer())).toEqual(file.slice(100, 200));
  });

  test('beyond the first 2 MB, or when the storage hides the full size, the request goes to the network as is', async () => {
    passed.length = 0;
    const s = fakeStore();
    await serveVideoRange(s, rangeReq(`bytes=${4 * K}-`), pass, storage().chunk);
    await serveVideoRange(s, rangeReq('bytes=0-'), pass, storage({ hideSize: true }).chunk);
    expect(passed).toEqual([`bytes=${4 * K}-`, 'bytes=0-']);
    expect(s.index.rows.size).toBe(0);
  });

  test('chunks count towards the auto bucket and are swept like files; the original and variants are separate keys', async () => {
    const s = fakeStore(), st = storage();
    await (await serveVideoRange(s, rangeReq('bytes=0-', `/files/${VID}`), pass, st.chunk, 0)).background;
    await (await serveVideoRange(s, rangeReq('bytes=0-', `/files/${VID}/preview`), pass, st.chunk, 0)).background;
    expect([...s.index.rows.keys()].sort()).toEqual([`${VID}/preview@0`, `${VID}@0`]);
    expect(await sweepAuto(s, { keepAutoDays: 1, maxAutoMb: 0 }, 2 * 24 * 3600_000)).toEqual({ removed: 2, autoBytes: 0 });
  });
});

import { encryptedSize, FILE_CHUNK, importFileKey, newFileKey, sealFile, toBase64 } from '@relay/protocol';
import { fileKeyOf, resetFileKeyCache, serveEncryptedRange } from './mediaCache';

describe('encrypted attachments in the service worker', () => {
  const VID = '0b6f8c1e-3f2a-4c55-9d7e-1a2b3c4d5e6f';
  const plainOf = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 13 + 1) & 255; b.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0); return b; };
  async function sealed(n: number) {
    const raw = newFileKey();
    const bytes = new Uint8Array(await (await sealFile(new Blob([plainOf(n)]), await importFileKey(raw))).arrayBuffer());
    const asked: string[] = [];
    const chunk = async (_u: string, range: string) => {
      asked.push(range);
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
      return new Response(bytes.slice(Number(a), Number(b) + 1), { status: 206 });
    };
    return { raw, bytes, asked, chunk };
  }
  const rq = (range: string, path = `/files/${VID}`) => new Request('http://app' + path, { headers: { range } });

  test('a whole encrypted file is served decrypted (with a sniffed type) and kept decrypted', async () => {
    const s = fakeStore();
    const { raw, bytes } = await sealed(3000);
    const out = await serveMedia(s, req(ID), async () => new Response(bytes), 1, raw);
    await out.background;
    expect(out.response.headers.get('content-type')).toBe('video/mp4');
    expect(new Uint8Array(await out.response.arrayBuffer())).toEqual(plainOf(3000));
    const again = await serveMedia(s, req(ID), async () => { throw new Error('offline'); }, 2, raw);
    expect(new Uint8Array(await again.response.arrayBuffer())).toEqual(plainOf(3000));
  });

  test('Range: plaintext bytes across chunk boundaries, honest Content-Range with the plain size, start chunks cached', async () => {
    const s = fakeStore();
    const n = 3 * FILE_CHUNK + 777;
    const { raw, chunk, asked } = await sealed(n);
    resetFileKeyCache();
    const a = await serveEncryptedRange(s, rq(`bytes=${FILE_CHUNK - 10}-`), raw, chunk, 1);
    await a.background;
    expect(a.response.status).toBe(206);
    const body = new Uint8Array(await a.response.arrayBuffer());
    expect(a.response.headers.get('content-range')).toBe(`bytes ${FILE_CHUNK - 10}-${FILE_CHUNK - 10 + body.length - 1}/${n}`);
    expect(body).toEqual(plainOf(n).slice(FILE_CHUNK - 10, FILE_CHUNK - 10 + body.length));
    expect(asked[0]).toBe('bytes=0-23');   // заголовок — один раз
    // тот же диапазон — из кэша кусков, без сети
    asked.length = 0;
    const b = await serveEncryptedRange(s, rq(`bytes=${FILE_CHUNK - 10}-${FILE_CHUNK + 5}`), raw, async () => { throw new Error('offline'); }, 2);
    expect(new Uint8Array(await b.response.arrayBuffer())).toEqual(plainOf(n).slice(FILE_CHUNK - 10, FILE_CHUNK + 6));
    // последний кусок и 416 за концом
    const tail = await serveEncryptedRange(s, rq(`bytes=${n - 5}-`), raw, chunk, 3);
    expect(new Uint8Array(await tail.response.arrayBuffer())).toEqual(plainOf(n).slice(n - 5));
    expect((await serveEncryptedRange(s, rq(`bytes=${n}-`), raw, chunk, 4)).response.status).toBe(416);
    expect(encryptedSize(n)).toBeGreaterThan(n);
  });

  test('file key lookup: IndexedDB first, then the tab; a file without a key is remembered as plain', async () => {
    resetFileKeyCache();
    const k = newFileKey();
    let asks = 0;
    const s = { ...fakeStore(), keys: { get: async (id: string) => (id === 'aaaa' ? toBase64(k) : undefined), clear: async () => {} }, askKey: async (id: string) => { asks++; return id === 'bbbb' ? toBase64(k) : null; } };
    expect(await fileKeyOf(s, 'aaaa')).toEqual(k);
    expect(await fileKeyOf(s, 'bbbb')).toEqual(k);
    expect(await fileKeyOf(s, 'cccc')).toBeNull();
    expect(await fileKeyOf(s, 'cccc')).toBeNull();
    expect(asks).toBe(2);   // «ключа нет» запомнено — вкладку второй раз не спрашиваем
    expect(await fileKeyOf(s, 'aaaa/preview')).not.toEqual(k);   // копия — выведенным ключом
  });
});
