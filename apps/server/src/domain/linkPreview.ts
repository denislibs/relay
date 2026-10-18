// Превью ссылок, как в Telegram: сервер сам открывает страницу, берёт OG-метаданные (сайт, заголовок, описание,
// картинку) и кладёт картинку в наше хранилище — браузеры получателей не ходят на чужой сайт.
// Безопасность (SSRF): только http/https на стандартных портах; каждый адрес из DNS проверяется — никаких localhost,
// внутренних и служебных сетей; редиректы — вручную, с той же проверкой на каждом шаге; таймаут и потолок размера.
import type { Entity, LinkPreview } from '@relay/protocol';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { sql } from '../db';
import { s3 } from './files';
import { systemUserId } from './service';

const TIMEOUT_MS = 6000;
const MAX_HTML = 1.5 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const FRESH_MS = 24 * 3600 * 1000;   // кэш страницы — сутки
const UA = 'Mozilla/5.0 (compatible; RelayBot/1.0; +link preview) like TelegramBot';

/** Первая ссылка сообщения: из оформления (текст-ссылка) или из самого текста (http(s)://…, www.…). */
export function firstUrl(body: string, entities: Entity[] = []): string | null {
  const ent = entities.filter((e) => e.type === 'link' && e.url).sort((a, b) => a.offset - b.offset)[0];
  const m = /\b(?:https?:\/\/|www\.)[^\s<>"'«»]+/i.exec(body);
  const fromText = m ? m[0].replace(/[.,!?:;)\]}»"']+$/, '') : null;
  const pick = ent && (!m || ent.offset <= m.index) ? ent.url! : fromText;
  if (!pick) return null;
  return normalizeUrl(/^www\./i.test(pick) ? 'https://' + pick : pick);
}

/** Адрес для превью: только http/https, стандартный порт, без логина и якоря. Иначе null. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443' && !allowPrivate) return null;
  u.hash = '';
  return u.toString().slice(0, 2048);
}

/** Публичный ли адрес: отсекаем петлю, частные, служебные, link-local, CGNAT, multicast и их IPv6-аналоги. */
export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;   // CGNAT
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPublicIp(mapped[1]);
    if (/^(fc|fd)/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x)) return false;
    return true;
  }
  return false;
}

/** Только для тестов: разрешить локальные адреса (тестовая страница поднимается на localhost). */
let allowPrivate = false;
export function allowPrivateHostsForTests(on: boolean): void { allowPrivate = on; }

async function assertPublicHost(host: string): Promise<void> {
  if (allowPrivate) return;
  const name = host.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(name)) throw new Error('private host');
  const addrs = isIP(name) ? [{ address: name }] : await lookup(name, { all: true });
  if (!addrs.length || !addrs.every((a) => isPublicIp(a.address))) throw new Error('private address');
}

/** Запрос с проверкой каждого шага и потолком размера тела. Возвращает итоговый адрес, тип и байты. */
async function safeGet(url: string, accept: string, maxBytes: number): Promise<{ url: string; type: string; bytes: Uint8Array }> {
  let cur = url;
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(cur);
    await assertPublicHost(u.hostname);
    const res = await fetch(cur, { redirect: 'manual', signal: deadline, headers: { 'user-agent': UA, accept, 'accept-language': 'ru,en;q=0.8' } });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      const n = next ? normalizeUrl(new URL(next, cur).toString()) : null;
      if (!n) throw new Error('bad redirect');
      cur = n;
      continue;
    }
    if (!res.ok || !res.body) throw new Error('status ' + res.status);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error('too big');
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { await reader.cancel(); if (accept.startsWith('image')) throw new Error('too big'); break; }   // у страницы метаданные в начале — хватит и начала
      parts.push(value);
    }
    const bytes = new Uint8Array(Math.min(total, maxBytes));
    let at = 0;
    for (const p of parts) { bytes.set(p.subarray(0, bytes.length - at), at); at += p.length; if (at >= bytes.length) break; }
    return { url: cur, type: (res.headers.get('content-type') || '').toLowerCase(), bytes };
  }
  throw new Error('too many redirects');
}

/** Кодировка страницы: из заголовка или <meta charset> в начале; по умолчанию UTF-8. */
function decodeHtml(bytes: Uint8Array, type: string): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const cs = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
  try { return new TextDecoder(cs.toLowerCase()).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

/** OG/Twitter/обычные meta и <title> — через HTMLRewriter (настоящий HTML-разбор, не регулярки). */
async function readMeta(html: string): Promise<{ meta: Map<string, string>; title: string }> {
  const meta = new Map<string, string>();
  let title = '', inTitle = false;
  await new HTMLRewriter()
    .on('meta', { element(e) {
      const k = (e.getAttribute('property') || e.getAttribute('name') || e.getAttribute('itemprop') || '').toLowerCase();
      const v = e.getAttribute('content');
      if (k && v && !meta.has(k)) meta.set(k, v);
    } })
    .on('title', { element() { inTitle = true; }, text(t) { if (inTitle && title.length < 500) title += t.text; if (t.lastInTextNode) inTitle = false; } })
    .transform(new Response(html)).text();
  return { meta, title: title.trim() };
}

const clean = (s: string | undefined | null, max: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t) : null;
};

/** Размеры картинки по заголовку файла (PNG, GIF, JPEG, WebP). */
export function imageSize(b: Uint8Array): { w: number; h: number; mime: string } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: dv.getUint32(16), h: dv.getUint32(20), mime: 'image/png' };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true), mime: 'image/gif' };
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8 ') return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff, mime: 'image/webp' };
    if (kind === 'VP8L') { const v = dv.getUint32(21, true); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1, mime: 'image/webp' }; }
    if (kind === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), mime: 'image/webp' };
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5), mime: 'image/jpeg' };
      i += 2 + len;
    }
  }
  return null;
}

/** Картинку — в наше хранилище от имени системного пользователя; доступ к ней даёт запись в link_previews. */
async function storePhoto(src: string): Promise<{ id: string; w: number; h: number } | null> {
  try {
    const { bytes } = await safeGet(src, 'image/*', MAX_IMAGE);
    const size = imageSize(bytes);
    if (!size || size.w < 32 || size.h < 32 || size.w > 10000 || size.h > 10000) return null;
    const owner = await systemUserId();
    const [row] = await sql`insert into attachments (owner_id, mime, name, size, status, kind, width, height)
      values (${owner}, ${size.mime}, 'preview', ${bytes.length}, 'ready', 'photo', ${size.w}, ${size.h}) returning id`;
    await s3().write(row.id as string, bytes, { type: size.mime });
    return { id: row.id as string, w: size.w, h: size.h };
  } catch { return null; }
}

/** Загрузить страницу и собрать превью (без кэша). null — у страницы нечего показать. */
export async function fetchPreview(url: string): Promise<LinkPreview | null> {
  const page = await safeGet(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', MAX_HTML);
  if (!/html|xml/.test(page.type) && page.type) return null;
  const { meta, title: docTitle } = await readMeta(decodeHtml(page.bytes, page.type));
  const host = new URL(page.url).hostname.replace(/^www\./, '');
  const title = clean(meta.get('og:title') || meta.get('twitter:title') || docTitle, 200);
  const description = clean(meta.get('og:description') || meta.get('twitter:description') || meta.get('description'), 300);
  const siteName = clean(meta.get('og:site_name'), 80) ?? host;
  const imageRaw = meta.get('og:image:secure_url') || meta.get('og:image') || meta.get('og:image:url') || meta.get('twitter:image') || meta.get('twitter:image:src');
  const image = imageRaw ? normalizeUrl(new URL(imageRaw, page.url).toString()) : null;
  if (!title && !description && !image) return null;
  const photo = image ? await storePhoto(image) : null;
  return { url, siteName, title, description, photo };
}

/** Превью из кэша (свежее суток) или загрузка с записью в кэш. Ошибка загрузки — «превью нет» (тоже кэшируется). */
export async function getPreview(url: string): Promise<LinkPreview | null> {
  const [hit] = await sql`select data, fetched_at from link_previews where url = ${url}`;
  if (hit && Date.now() - (hit.fetched_at as Date).getTime() < FRESH_MS) return (hit.data as LinkPreview | null) ?? null;
  let data: LinkPreview | null = null;
  try { data = await fetchPreview(url); } catch { data = null; }
  await sql`insert into link_previews (url, data, photo_id, fetched_at) values (${url}, ${data ? sql.json(data as never) : null}, ${data?.photo?.id ?? null}, now())
    on conflict (url) do update set data = excluded.data, photo_id = excluded.photo_id, fetched_at = now()`;
  return data;
}

/** Готовое превью из кэша без загрузки (для сообщения, которое отправляют прямо сейчас). undefined — в кэше нет. */
export async function cachedPreview(url: string): Promise<LinkPreview | null | undefined> {
  const [hit] = await sql`select data, fetched_at from link_previews where url = ${url}`;
  if (!hit || Date.now() - (hit.fetched_at as Date).getTime() >= FRESH_MS) return undefined;
  return (hit.data as LinkPreview | null) ?? null;
}
