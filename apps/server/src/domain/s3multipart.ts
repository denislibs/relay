import { createHash, createHmac } from 'node:crypto';

/**
 * Multipart-загрузка S3 (CreateMultipartUpload / UploadPart / ListParts / Complete / Abort). У Bun.S3Client нет ни этих
 * вызовов, ни подписи ссылки с параметрами запроса (partNumber, uploadId) — поэтому AWS SigV4 здесь вручную, без зависимостей.
 * Адресация path-style, как у Bun: {endpoint}/{bucket}/{key}.
 */
export interface S3Conf { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const hmac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();
const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function signingKey(c: S3Conf, day: string): Buffer {
  return hmac(hmac(hmac(hmac('AWS4' + c.secretAccessKey, day), c.region), 's3'), 'aws4_request');
}
const canonicalQuery = (q: Record<string, string>) => Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');

function target(c: S3Conf, key: string): { url: URL; path: string } {
  const url = new URL(c.endpoint.replace(/\/+$/, '') + '/' + c.bucket + (key ? '/' + key.split('/').map(enc).join('/') : ''));
  return { url, path: url.pathname };
}

/** Подписанная ссылка (подписан только host): то же, что S3Client.presign, но с любыми параметрами запроса. */
export function presign(c: S3Conf, method: string, key: string, query: Record<string, string>, expiresIn: number, now = new Date()): string {
  const { url, path } = target(c, key);
  const date = amzDate(now), day = date.slice(0, 8), scope = `${day}/${c.region}/s3/aws4_request`;
  const q: Record<string, string> = { ...query, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${c.accessKeyId}/${scope}`,
    'X-Amz-Date': date, 'X-Amz-Expires': String(expiresIn), 'X-Amz-SignedHeaders': 'host' };
  const canonical = [method, path, canonicalQuery(q), `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  const sig = createHmac('sha256', signingKey(c, day)).update(toSign).digest('hex');
  return `${url.origin}${path}?${canonicalQuery(q)}&X-Amz-Signature=${sig}`;
}

/** Запрос к хранилищу с подписью в заголовке Authorization (сервер → S3 по внутреннему адресу). */
async function call(c: S3Conf, method: string, key: string, query: Record<string, string>, body = '', extra: Record<string, string> = {}): Promise<string> {
  const { url, path } = target(c, key);
  const date = amzDate(new Date()), day = date.slice(0, 8), scope = `${day}/${c.region}/s3/aws4_request`;
  const hash = sha256(body);
  const headers: Record<string, string> = { ...extra, host: url.host, 'x-amz-content-sha256': hash, 'x-amz-date': date };
  const names = Object.keys(headers).sort();
  const qs = canonicalQuery(query);
  const canonical = [method, path, qs, names.map((h) => `${h}:${headers[h]}\n`).join(''), names.join(';'), hash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  const sig = createHmac('sha256', signingKey(c, day)).update(toSign).digest('hex');
  const { host: _, ...send } = headers;
  const r = await fetch(`${url.origin}${path}${qs ? '?' + qs : ''}`, { method, body: body || undefined, headers: {
    ...send, authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`,
    ...(body && !extra['content-type'] ? { 'content-type': 'application/xml' } : {}) } });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`s3 ${method} ${r.status}: ${text.slice(0, 300)}`), { status: r.status, s3Code: /<Code>([^<]+)<\/Code>/.exec(text)?.[1] });
  return text;
}

const tag = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** CreateMultipartUpload: тип объекта задаётся здесь — у готового объекта будет он (части его не несут). */
export async function createMultipart(c: S3Conf, key: string, mime: string): Promise<string> {
  const id = tag(await call(c, 'POST', key, { uploads: '' }, '', { 'content-type': mime }), 'UploadId')[0];
  if (!id) throw new Error('s3: no UploadId');
  return id;
}

/** Ссылка на одну часть (PUT тела части по ней). */
export const presignPart = (c: S3Conf, key: string, uploadId: string, partNumber: number, expiresIn: number) =>
  presign(c, 'PUT', key, { partNumber: String(partNumber), uploadId }, expiresIn);

/** Части, которые хранилище уже приняло (все страницы ListParts). */
export async function listParts(c: S3Conf, key: string, uploadId: string): Promise<{ n: number; etag: string; size: number }[]> {
  const out: { n: number; etag: string; size: number }[] = [];
  let marker = '';
  for (let page = 0; page < 100; page++) {
    const xml = await call(c, 'GET', key, { uploadId, 'max-parts': '1000', ...(marker ? { 'part-number-marker': marker } : {}) });
    for (const p of tag(xml, 'Part')) {
      out.push({ n: Number(tag(p, 'PartNumber')[0]), etag: unxml(tag(p, 'ETag')[0] ?? ''), size: Number(tag(p, 'Size')[0]) });
    }
    if (tag(xml, 'IsTruncated')[0] !== 'true') break;
    marker = tag(xml, 'NextPartNumberMarker')[0] ?? '';
    if (!marker) break;
  }
  // SeaweedFS перечисляет перезалитую часть дважды: остаётся последняя (в хранилище тоже действует последняя)
  return [...new Map(out.map((p) => [p.n, p])).values()].sort((a, b) => a.n - b.n);
}

export async function completeMultipart(c: S3Conf, key: string, uploadId: string, parts: { n: number; etag: string }[]): Promise<void> {
  const body = '<CompleteMultipartUpload>' + parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEsc(p.etag)}</ETag></Part>`).join('') + '</CompleteMultipartUpload>';
  const xml = await call(c, 'POST', key, { uploadId }, body);
  // S3 может ответить 200 с ошибкой в теле
  if (/<Error>/.test(xml)) throw new Error(`s3 complete: ${xml.slice(0, 300)}`);
}

/** Отмена: хранилище выбрасывает принятые части. Уже отменённая (NoSuchUpload) — не ошибка. */
export async function abortMultipart(c: S3Conf, key: string, uploadId: string): Promise<void> {
  try { await call(c, 'DELETE', key, { uploadId }); }
  catch (e) { if ((e as { status?: number }).status !== 404) throw e; }
}

/** Незавершённые загрузки бакета (для уборки брошенных): ключ, uploadId, когда начата. */
export async function listMultipart(c: S3Conf): Promise<{ key: string; uploadId: string; initiated: Date }[]> {
  const out: { key: string; uploadId: string; initiated: Date }[] = [];
  let keyMarker = '', idMarker = '';
  for (let page = 0; page < 100; page++) {
    const xml = await call(c, 'GET', '', { uploads: '', ...(keyMarker ? { 'key-marker': keyMarker } : {}), ...(idMarker ? { 'upload-id-marker': idMarker } : {}) });
    for (const u of tag(xml, 'Upload')) out.push({ key: unxml(tag(u, 'Key')[0] ?? ''), uploadId: tag(u, 'UploadId')[0] ?? '', initiated: new Date(tag(u, 'Initiated')[0] ?? 0) });
    if (tag(xml, 'IsTruncated')[0] !== 'true') break;
    keyMarker = tag(xml, 'NextKeyMarker')[0] ?? ''; idMarker = tag(xml, 'NextUploadIdMarker')[0] ?? '';
    if (!keyMarker) break;
  }
  return out;
}

/** CopyObject внутри бакета (сервер → S3): объект целиком, тип и тело — как у источника. До 5 ГБ одним вызовом. */
export async function copyObject(c: S3Conf, from: string, to: string): Promise<void> {
  const src = '/' + c.bucket + '/' + from.split('/').map(enc).join('/');
  await call(c, 'PUT', to, {}, '', { 'x-amz-copy-source': src });
}
