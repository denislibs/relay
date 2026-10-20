/**
 * Загрузка большого файла частями (S3 multipart), как в Telegram: части идут по 4 параллельно прямо в хранилище,
 * каждая — срез Blob (файл целиком в память не читается). Принятые части движок сохраняет в outbox (IndexedDB),
 * поэтому обрыв связи или перезагрузка вкладки теряют только части, что были в пути.
 */

/** Состояние загрузки частями в записи outbox: id вложения на сервере, разбивка и номера принятых частей.
 *  key/base — ключ файла и основа nonce (base64): шифр должен быть тем же после перезагрузки — части уже в хранилище. */
export interface MultipartState { id: string; partSize: number; parts: number; done: number[]; key?: string; base?: string }

/** Что грузим: Blob или шифр поверх него (fileCrypto.sealedSource) — байты [a, b) без чтения файла целиком. */
export interface UploadSource { size: number; slice(a: number, b: number): Blob | Promise<Blob> }

type ReqError = { code: string; retry: boolean };

export interface PartsIo {
  /** Подписанные PUT на части (сервер: POST /uploads/:id/parts). */
  urls(numbers: number[]): Promise<Record<number, string>>;
  /** Часть принята — сохранить (outbox). Вызывается по одной, в порядке окончания. */
  saved(done: number[]): Promise<void>;
  /** Доля загруженного 0..1 — уже принятые части плюс байты частей в пути. */
  progress(loaded: number): void;
  /** Отмена из ленты (discard) или очистка: прервать все PUT. */
  register(ctl: { abort(): void }): void;
  cancelled(): boolean;
  offline(): boolean;
}

export const PARALLEL = 4;
/** Ссылок за один запрос к серверу: хватает на несколько частей вперёд, но не так много, чтобы они истекли в очереди. */
const URL_BATCH = 16;

const partLen = (s: MultipartState, size: number, n: number) => Math.min(s.partSize, size - (n - 1) * s.partSize);

export async function uploadParts(blob: UploadSource, s: MultipartState, io: PartsIo): Promise<void> {
  const done = new Set(s.done);
  const queue: number[] = [];
  for (let n = 1; n <= s.parts; n++) if (!done.has(n)) queue.push(n);
  let doneBytes = 0;
  for (const n of done) doneBytes += partLen(s, blob.size, n);
  const inflight = new Map<number, number>();
  const report = () => { let b = doneBytes; for (const v of inflight.values()) b += v; io.progress(b / blob.size); };
  report();
  if (!queue.length) return;

  const urls = new Map<number, string>();
  let batch: Promise<void> | null = null;
  /** Ссылка на часть n: пачкой на неё и следующие в очереди; одновременно идёт один запрос ссылок. */
  const urlFor = async (n: number): Promise<string> => {
    while (!urls.has(n)) {
      if (!batch) {
        const want = [n, ...queue.filter((q) => !urls.has(q))].slice(0, URL_BATCH);
        batch = io.urls(want).then((r) => { for (const [k, v] of Object.entries(r)) urls.set(Number(k), v); }).finally(() => { batch = null; });
      }
      await batch;
    }
    return urls.get(n)!;
  };

  const xhrs = new Set<{ abort(): void }>();
  let failure: ReqError | null = null;
  const stop = (e: ReqError) => { if (!failure) { failure = e; for (const x of xhrs) x.abort(); } };
  io.register({ abort: () => stop({ code: io.cancelled() ? 'cancelled' : 'offline', retry: !io.cancelled() }) });
  let expired = 0;

  const worker = async () => {
    while (!failure && queue.length) {
      const n = queue.shift()!;
      try {
        const url = await urlFor(n);
        if (failure) return;
        const body = await blob.slice((n - 1) * s.partSize, (n - 1) * s.partSize + partLen(s, blob.size, n));
        if (failure) return;
        await putPart(url, body, xhrs, io, (loaded) => { inflight.set(n, loaded); report(); });
        inflight.delete(n);
        done.add(n);
        doneBytes += partLen(s, blob.size, n);
        report();
        await io.saved([...done].sort((a, b) => a - b));
      } catch (e) {
        inflight.delete(n);
        // ссылка истекла (долго стояли в очереди или были офлайн): возьмём новые, часть — снова в очередь
        if ((e as { status?: number }).status === 403 && ++expired <= 3) { urls.clear(); queue.unshift(n); continue; }
        stop(io.cancelled() ? { code: 'cancelled', retry: false } : (e as { code?: string }).code ? e as ReqError : { code: 'upload', retry: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  if (failure) throw failure;
}

/** PUT одной части: XHR с прогрессом (есть в воркерах браузера), иначе fetch. Ошибка — { status } от хранилища или offline. */
function putPart(url: string, body: Blob, xhrs: Set<{ abort(): void }>, io: PartsIo, progress: (loaded: number) => void): Promise<void> {
  const offline: ReqError = { code: 'offline', retry: true };
  if (io.offline()) return Promise.reject(offline);
  const fail = (status: number) => (status === 403 ? { status } : { code: 'upload', retry: status >= 500 || status === 408 || status === 429, status });
  if (typeof XMLHttpRequest === 'undefined') {
    const ac = new AbortController();
    xhrs.add(ac);
    return fetch(url, { method: 'PUT', body, signal: ac.signal })
      .then((r) => { if (!r.ok) throw fail(r.status); progress(body.size); }, () => { throw offline; })
      .finally(() => xhrs.delete(ac));
  }
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    let last = 0;
    x.upload.onprogress = (e) => {
      if (e.timeStamp - last < 100) return;   // не чаще 10 раз в секунду на часть
      last = e.timeStamp;
      progress(e.loaded);
    };
    x.onload = () => { xhrs.delete(x); if (x.status < 300) resolve(); else reject(fail(x.status)); };
    x.onerror = () => { xhrs.delete(x); reject(offline); };
    x.onabort = () => { xhrs.delete(x); reject(offline); };
    xhrs.add(x);
    x.send(body);
  });
}
