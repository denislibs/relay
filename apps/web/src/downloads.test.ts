import { describe, expect, test } from 'bun:test';
import { DownloadError, downloadChunks } from './downloads';
import { isMediaRangeRequest, isMediaRequest, storeMedia } from './mediaCache';

const FILES = 'https://relay.test/files/f?download=1';
const signed = (n: number) => `https://s3.test/obj?sig=${n}`;

/**
 * Подставное хранилище: /files отвечает «редиректом» на подписанную ссылку (Response.redirected/url),
 * ссылка живёт до expireAfter запросов по ней; drops — после скольких байт оборвать очередной ответ.
 */
function fakeStore(data: Uint8Array, o: { expireAfter?: number; drops?: number[]; offlineOnce?: boolean } = {}) {
  let sig = 0, usedOnSig = 0;
  const log: { url: string; range: string; cache?: string; credentials?: string }[] = [];
  const drops = [...(o.drops ?? [])];
  let offline = !!o.offlineOnce;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const range = (init?.headers as Record<string, string>).range;
    log.push({ url, range, cache: init?.cache, credentials: init?.credentials });
    if (offline) { offline = false; throw new TypeError('Failed to fetch'); }
    let final = url;
    if (url === FILES) { sig++; usedOnSig = 0; final = signed(sig); }
    else if (url !== signed(sig) || (o.expireAfter != null && ++usedOnSig > o.expireAfter)) {
      return new Response('<Error>AccessDenied</Error>', { status: 403 });
    }
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
    const slice = data.slice(Number(a), Math.min(data.length, Number(b) + 1));
    const cut = drops.length ? drops.shift()! : -1;
    // по 1000 байт за чтение; cut — отдали столько и оборвали соединение
    let pos = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        const stop = cut >= 0 ? cut : slice.length;
        if (pos >= stop) { if (cut >= 0) c.error(new TypeError('network error')); else c.close(); return; }
        c.enqueue(slice.slice(pos, Math.min(stop, pos + 1000))); pos += 1000;
        if (pos > stop) pos = stop;
      },
    });
    const res = new Response(body, { status: 206, headers: { 'content-length': String(slice.length) } });
    Object.defineProperty(res, 'redirected', { value: url === FILES });
    Object.defineProperty(res, 'url', { value: final });
    return res;
  };
  return { fetch, log };
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
const same = async (blob: Blob, data: Uint8Array) => expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
const noSleep = async () => {};

describe('downloadChunks', () => {
  test('частями по Range: первый через /files, дальше прямо по подписанной ссылке; прогресс до конца', async () => {
    const data = bytes(25_000);
    const s = fakeStore(data);
    const progress: number[] = [];
    const blob = await downloadChunks({ url: FILES, size: data.length, chunk: 10_000, fetch: s.fetch, sleep: noSleep, online: () => null, onProgress: (l) => progress.push(l), type: 'application/pdf' });
    await same(blob, data);
    expect(blob.type).toBe('application/pdf');
    expect(s.log.map((l) => l.range)).toEqual(['bytes=0-9999', 'bytes=10000-19999', 'bytes=20000-24999']);
    expect(s.log[0].url).toBe(FILES);
    expect(s.log[0].credentials).toBe('same-origin');
    expect(s.log.slice(1).every((l) => l.url === signed(1) && l.credentials === 'omit')).toBe(true);
    expect(progress.at(-1)).toBe(25_000);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true);
  });

  test('обрыв посреди части — продолжаем с последнего полученного байта, ничего не теряя', async () => {
    const data = bytes(30_000);
    const s = fakeStore(data, { drops: [-1, 4_321] });   // вторая часть рвётся после 4321 байт
    const blob = await downloadChunks({ url: FILES, size: data.length, chunk: 10_000, fetch: s.fetch, sleep: noSleep, online: () => null });
    await same(blob, data);
    expect(s.log.map((l) => l.range)).toEqual(['bytes=0-9999', 'bytes=10000-19999', 'bytes=14321-24320', 'bytes=24321-29999']);
  });

  test('истёкшая ссылка (403) — новая через /files мимо кэша браузера, и дальше по ней', async () => {
    const data = bytes(40_000);
    const s = fakeStore(data, { expireAfter: 1 });   // по каждой ссылке — только один запрос
    const blob = await downloadChunks({ url: FILES, size: data.length, chunk: 10_000, fetch: s.fetch, sleep: noSleep, online: () => null });
    await same(blob, data);
    const files = s.log.filter((l) => l.url === FILES);
    expect(files.length).toBe(2);              // первый раз и после истечения
    expect(files[1].cache).toBe('no-store');   // закэшированный редирект мог вести на ту же истёкшую ссылку
    expect(s.log.map((l) => l.range)).toEqual(['bytes=0-9999', 'bytes=10000-19999', 'bytes=20000-29999', 'bytes=20000-29999', 'bytes=30000-39999']);
  });

  test('нет доступа (403 и на свежую ссылку) — ошибка forbidden, а не вечный цикл', async () => {
    const fetch = async () => new Response('', { status: 403 });
    await expect(downloadChunks({ url: FILES, size: 100, fetch, sleep: noSleep, online: () => null })).rejects.toMatchObject({ code: 'forbidden' });
  });

  test('404 — not_found сразу', async () => {
    const fetch = async () => new Response('', { status: 404 });
    await expect(downloadChunks({ url: FILES, size: 100, fetch, sleep: noSleep, online: () => null })).rejects.toMatchObject({ code: 'not_found' });
  });

  test('без сети — ждём её (onWaiting), потом продолжаем', async () => {
    const data = bytes(12_000);
    const s = fakeStore(data, { offlineOnce: true });
    let back!: () => void;
    let asked = 0;
    const waits: boolean[] = [];
    const p = downloadChunks({ url: FILES, size: data.length, chunk: 10_000, fetch: s.fetch, sleep: noSleep,
      online: () => (asked++ === 0 ? new Promise<void>((r) => { back = r; }) : null), onWaiting: (w) => waits.push(w) });
    await new Promise((r) => setTimeout(r, 5));
    expect(waits).toEqual([true]);
    back();
    await same(await p, data);
    expect(waits).toEqual([true, false]);
  });

  test('сервер всё время падает — после нескольких попыток network', async () => {
    let n = 0;
    const fetch = async () => { n++; return new Response('', { status: 503 }); };
    await expect(downloadChunks({ url: FILES, size: 100, fetch, sleep: noSleep, online: () => null })).rejects.toMatchObject({ code: 'network' });
    expect(n).toBe(9);
  });

  test('отмена — aborted, запросы прекращаются', async () => {
    const data = bytes(50_000);
    const s = fakeStore(data);
    const ctrl = new AbortController();
    const p = downloadChunks({ url: FILES, size: data.length, chunk: 10_000, fetch: s.fetch, sleep: noSleep, online: () => null, signal: ctrl.signal,
      onProgress: (l) => { if (l >= 15_000) ctrl.abort(); } });
    await expect(p).rejects.toBeInstanceOf(DownloadError);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(s.log.length).toBeLessThanOrEqual(2);
  });

  test('размер неизвестен — берём из Content-Range', async () => {
    const data = bytes(15_000);
    const fetch = async (_u: string, init?: RequestInit) => {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec((init?.headers as Record<string, string>).range)!;
      const slice = data.slice(Number(a), Math.min(data.length, Number(b) + 1));
      return new Response(slice, { status: 206, headers: { 'content-range': `bytes ${a}-${Number(a) + slice.length - 1}/${data.length}` } });
    };
    await same(await downloadChunks({ url: FILES, chunk: 10_000, fetch, sleep: noSleep, online: () => null }), data);
  });
});

describe('кэш: только целые файлы', () => {
  const id = '0e0e0e0e-0000-4000-8000-000000000001';
  test('storeMedia кладёт целый файл под /files/<id> с типом и длиной — его потом отдаёт SW и видит «Данные и память»', async () => {
    const m = new Map<string, Response>();
    const caches = { open: async () => ({ put: async (k: string, r: Response) => { m.set(k, r); } }) } as unknown as Pick<CacheStorage, 'open'>;
    await storeMedia(caches, id, new Blob([bytes(1000)], { type: 'video/mp4' }), 1234);
    const res = m.get(`/files/${id}`)!;
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('x-relay-used')).toBe('1234');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes(1000));
  });

  test('Range к /files/<id> — в сеть (не в кэш), целый GET — через кэш', () => {
    const o = 'https://relay.test';
    const range = new Request(`${o}/files/${id}`, { headers: { range: 'bytes=0-' } });
    expect(isMediaRangeRequest(range, o)).toBe(true);
    expect(isMediaRequest(range, o)).toBe(false);
    expect(isMediaRangeRequest(new Request(`${o}/files/${id}`), o)).toBe(false);
    expect(isMediaRangeRequest(new Request(`${o}/files/${id}?download=1`, { headers: { range: 'bytes=0-' } }), o)).toBe(false);
  });
});
