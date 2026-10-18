import { parseClientFrame } from '@relay/protocol';
import { clientIp } from './device';
import type { Server } from 'bun';
import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { clearSessionCookie, createSession, createUser, deleteSession, readSessionToken, sessionCookie, sessionFromToken } from './auth';
import { announceLogin, announceSessionsChanged, assertConfirmed, checkSocket, confirmSession, listSessions, sessionEnded, sweepInactive, terminateOthers, terminateSession, trackSocket, untrackSocket } from './domain/sessions';
import { createChat, getChatMedia, getHistory, getMessagesByIds, listChats, listChatsPage } from './domain/chats';
import { sql } from './db';
import { DomainError } from './domain/errors';
import { connected, disconnected, listPresence, type Publish } from './domain/presence';
import { searchMessages } from './domain/search';
import { fileFor, MAX_FILE, storeUpload } from './domain/files';
import { handleFrame } from './ws';
import { journalStats } from './domain/journal';
import { notifyLatency } from './realtime';
import { checkUsername, getMe, getUser, setUsername, updateProfile } from './domain/profile';
import { usersByIds } from './domain/users';
import { subscribe, unsubscribe, vapidKeys, type SubscriptionInput } from './domain/push';
import { getSettings, setNotify, setPrivacy, setSessionsTtl } from './domain/settings';
import { requestCode, signIn } from './domain/login';
import { addContact, blockUser, listBlocked, listContacts, removeContact, resolveUser, unblockUser, updateContact } from './domain/contacts';

const STATUS: Record<string, number> = { bad_frame: 400, too_long: 400, username_invalid: 400, username_reserved: 400, username_taken: 409, bio_too_long: 400, note_too_long: 400, name_invalid: 400, birthday_invalid: 400, unauthorized: 401, not_member: 403, blocked: 403, not_found: 404, code_invalid: 400, code_expired: 400, flood: 429, fresh_session: 403 };
const fail = (code: string) => Response.json({ code }, { status: STATUS[code] ?? 500 });

/** checkedAt — когда сокет последний раз отмечал активность и проверял свой сеанс (domain/sessions.checkSocket). */
export type WsData = { userId: number; sessionId: number; checkedAt: number };

/** /dev/stats: ответ на пользователя живёт devStatsMs (тесты ставят 0). */
let devStatsMs = 1000;
const devStatsCache = new Map<number, { at: number; body: Promise<unknown> }>();
export function setDevStatsThrottleMs(ms: number): void { devStatsMs = ms; devStatsCache.clear(); }

/** Открытые сокеты пользователя в этом процессе (dev: /dev/stats). */
const userSockets = new Map<number, number>();
const countSocket = (userId: number, d: number) => {
  const n = (userSockets.get(userId) ?? 0) + d;
  if (n > 0) userSockets.set(userId, n); else userSockets.delete(userId);
};

/** Срок сеанса продлён (sessionFromToken.refresh): ответ несёт свежий cookie. */
const refreshed = new WeakMap<Request, string>();
function withCookie(req: Request, res: Response | undefined): Response | undefined {
  const token = refreshed.get(req);
  if (token && res && !res.headers.has('set-cookie')) { try { res.headers.set('set-cookie', sessionCookie(token)); } catch { /* неизменяемые заголовки */ } }
  return res;
}

const INLINE_MIME = /^(image\/(jpeg|png|webp|gif|avif)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|webm|wav|x-wav|aac|flac))$/;

const API = /^\/(health|me|users|contacts|settings|privacy|blocks|chats|presence|search|upload|files|push|sessions|ws|dev|logout|auth)(\/|$)/;

/** Статика клиента из WEB_DIST. Путь не может выйти за папку; пути без расширения — SPA, отдаём index.html. */
function serveStatic(pathname: string): Response {
  const dist = resolve(process.env.WEB_DIST ?? join(import.meta.dir, '..', '..', 'web', 'dist'));
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return new Response('Bad request', { status: 400 }); }
  const file = resolve(dist, '.' + (decoded === '/' ? '/index.html' : decoded));
  const inside = file === dist || file.startsWith(dist + sep);
  if (inside && existsSync(file) && statSync(file).isFile()) {
    const res = new Response(Bun.file(file));
    // имена файлов без хэша: браузер обязан перепроверять (ETag/Last-Modified), иначе после сборки держит старый CSS/JS
    res.headers.set('cache-control', 'no-cache');
    return res;
  }
  if (!extname(decoded) && existsSync(join(dist, 'index.html'))) {
    return new Response(Bun.file(join(dist, 'index.html')), { headers: { 'cache-control': 'no-cache' } });
  }
  return new Response('Not found', { status: 404 });
}

export function createServer(opts: { port: number }): Server {
  const publish: Publish = (topic, msg) => { server.publish(topic, msg); };
  const server = Bun.serve<WsData>({
    port: opts.port,
    fetch: async (req, server) => withCookie(req, await (async () => {
      const url = new URL(req.url);
      try {
        if (url.pathname === '/health') return Response.json({ ok: true });
        if ((req.method === 'GET' || req.method === 'HEAD') && !API.test(url.pathname)) return serveStatic(url.pathname);

        if (process.env.DEV_LOGIN === '1' && req.method === 'POST' && url.pathname === '/dev/login') {
          const { name, phone } = (await req.json()) as { name: string; phone?: string };
          // dev: вход по имени — существующий пользователь (в т.ч. из сида) или новый
          const [found] = await sql`select id from users where name = ${String(name ?? '')} and not system order by id limit 1`;
          const userId = found ? (found.id as number) : await createUser(String(name ?? 'user'));
          // dev: телефон нужен только для проверки профиля (SMS-входа нет); занятый номер не мешает входу
          if (typeof phone === 'string') await sql`update users set phone = ${phone} where id = ${userId} and phone is null`.catch(() => {});
          // createSession сам чистит неактивные сеансы и пишет устройство/IP (общий путь для любого входа)
          const token = await createSession(userId, { req, server });
          return Response.json({ userId, token }, { headers: { 'set-cookie': sessionCookie(token) } });
        }

        // публичный ключ VAPID — не секрет
        if (req.method === 'GET' && url.pathname === '/push/key') return Response.json({ key: (await vapidKeys()).publicKey });
        if (req.method === 'POST' && url.pathname === '/auth/code') {
          const { login } = ((await req.json().catch(() => null)) ?? {}) as { login?: unknown };
          if (typeof login !== 'string' || !login.trim() || login.length > 64) return fail('bad_frame');
          return Response.json(await requestCode(login, clientIp(req, server)));
        }
        if (req.method === 'POST' && url.pathname === '/auth/signin') {
          const { attemptId, code } = ((await req.json().catch(() => null)) ?? {}) as { attemptId?: unknown; code?: unknown };
          if (typeof attemptId !== 'string' || typeof code !== 'string') return fail('bad_frame');
          const { userId } = await signIn(attemptId, code);
          const token = await createSession(userId, { req, server }, { confirmed: false });
          await announceLogin(userId, token);
          return Response.json({ userId }, { headers: { 'set-cookie': sessionCookie(token) } });
        }
        const auth = await sessionFromToken(readSessionToken(req));
        if (!auth) return fail('unauthorized');
        const { userId, sessionId } = auth;
        if (auth.refresh) { const t = readSessionToken(req); if (t && req.headers.get('cookie')?.includes('relay_session=')) refreshed.set(req, t); }

        if (req.method === 'GET' && url.pathname === '/me') {
          return Response.json(await getMe(userId));
        }
        if (req.method === 'PATCH' && url.pathname === '/me') {
          return Response.json(await updateProfile(userId, await req.json().catch(() => null)));
        }
        if (req.method === 'PUT' && url.pathname === '/me/username') {
          const body = (await req.json().catch(() => null)) as { username?: unknown } | null;
          if (!body || !('username' in body)) return fail('bad_frame');
          return Response.json(await setUsername(userId, body.username));
        }
        if (req.method === 'GET' && url.pathname === '/users/check-username') {
          return Response.json(await checkUsername(userId, url.searchParams.get('u')));
        }
        if (req.method === 'POST' && url.pathname === '/users/resolve') {
          // POST, а не ?q=: номер телефона не должен попадать в URL и журналы доступа
          const body = (await req.json().catch(() => null)) as { query?: unknown } | null;
          return Response.json(await resolveUser(userId, body?.query));
        }
        if (url.pathname === '/contacts') {
          if (req.method === 'GET') return Response.json(await listContacts(userId));
          if (req.method === 'POST') return Response.json(await addContact(userId, await req.json().catch(() => null), publish));
        }
        const contact = /^\/contacts\/(\d{1,15})$/.exec(url.pathname);
        if (contact && req.method === 'PATCH') return Response.json(await updateContact(userId, Number(contact[1]), await req.json().catch(() => null)));
        if (contact && req.method === 'DELETE') return Response.json(await removeContact(userId, Number(contact[1]), publish));
        if (req.method === 'GET' && url.pathname === '/settings') return Response.json(await getSettings(userId));
        const notifyType = /^\/settings\/notify\/([a-z]{1,16})$/.exec(url.pathname);
        if (req.method === 'PUT' && notifyType) return Response.json(await setNotify(userId, notifyType[1], await req.json().catch(() => null)));
        const privacyKey = /^\/privacy\/([a-zA-Z]{1,16})$/.exec(url.pathname);
        if (req.method === 'PUT' && privacyKey) {
          return Response.json(await setPrivacy(userId, privacyKey[1], await req.json().catch(() => null), publish));
        }
        if (req.method === 'PUT' && url.pathname === '/settings/sessions-ttl') {
          await assertConfirmed(sql, sessionId);   // новый срок сразу завершает сеансы: свежий сеанс этого не может
          const res = await setSessionsTtl(userId, await req.json().catch(() => null));
          await sweepInactive(userId).catch((e) => console.error('sessions sweep:', e));   // новый срок короче — старые сеансы уходят сразу
          return Response.json(res);
        }
        if (url.pathname === '/sessions') {
          if (req.method === 'GET') return Response.json(await listSessions(userId, sessionId));
          if (req.method === 'DELETE') return url.searchParams.get('others') === '1' ? Response.json(await terminateOthers(userId, sessionId)) : fail('bad_frame');
        }
        const sess = /^\/sessions\/(\d{1,15})$/.exec(url.pathname);
        if (sess && req.method === 'DELETE') return Response.json(await terminateSession(userId, sessionId, Number(sess[1])));
        const confirm = /^\/sessions\/(\d{1,15})\/confirm$/.exec(url.pathname);
        if (confirm && req.method === 'POST') return Response.json(await confirmSession(userId, sessionId, Number(confirm[1])));
        if (req.method === 'GET' && url.pathname === '/blocks') return Response.json(await listBlocked(userId));
        const block = /^\/blocks\/(\d{1,15})$/.exec(url.pathname);
        if (block && (req.method === 'PUT' || req.method === 'DELETE')) {
          const target = Number(block[1]);
          return Response.json(req.method === 'PUT' ? await blockUser(userId, target, publish) : await unblockUser(userId, target, publish));
        }
        const user = /^\/users\/(\d{1,15})$/.exec(url.pathname);
        if (req.method === 'GET' && user) return Response.json(await getUser(userId, Number(user[1])));
        if (req.method === 'POST' && url.pathname === '/logout') {
          const token = readSessionToken(req);
          const ended = token ? await deleteSession(token) : null;
          // подписка Web Push сеанса ушла каскадом
          // сокеты этого же сеанса в других вкладках закрываются (sessionTerminated)
          if (ended != null) {
            await sessionEnded(ended).catch((e) => console.error('sessions:', e));
            await announceSessionsChanged(userId).catch((e) => console.error('sessions:', e));
          }
          return Response.json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie() } });
        }
        if (url.pathname === '/ws') {
          return server.upgrade(req, { data: { userId, sessionId, checkedAt: Date.now() } }) ? undefined : fail('bad_frame');
        }
        if (process.env.DEV_LOGIN === '1' && req.method === 'POST' && url.pathname === '/dev/chats') {
          const { kind, title, memberIds } = (await req.json()) as { kind: 'direct' | 'group'; title: string | null; memberIds: number[] };
          const ids = memberIds.includes(userId) ? memberIds : [userId, ...memberIds];
          return Response.json({ id: await createChat(kind, title, ids) });
        }
        if (process.env.DEV_LOGIN === '1' && req.method === 'GET' && url.pathname === '/dev/stats') {
          // count(*) по журналу и pg_notify — не чаще раза в devStatsMs на пользователя: повтор получает тот же ответ
          const hit = devStatsCache.get(userId);
          if (hit && Date.now() - hit.at < devStatsMs) return Response.json(await hit.body);
          const body = (async () => {
            const [j, notifyMs] = await Promise.all([journalStats(userId), notifyLatency().catch(() => null)]);
            return { at: Date.now(), userId, seq: j.seq, sockets: userSockets.get(userId) ?? 0, journal: { size: j.size, minSeq: j.minSeq }, notifyMs };
          })();
          devStatsCache.set(userId, { at: Date.now(), body });
          if (devStatsCache.size > 1000) devStatsCache.clear();
          try { return Response.json(await body); } catch (e) { devStatsCache.delete(userId); throw e; }
        }
        if (req.method === 'POST' && url.pathname === '/upload') {
          // тело — сам файл; ?name=…&w=…&h=… (размеры фото считает клиент, он его уже декодировал)
          const len = Number(req.headers.get('content-length') ?? 0);
          if (len > MAX_FILE) return fail('too_long');
          const n = (k: string) => { const v = Number(url.searchParams.get(k)); return Number.isFinite(v) && v > 0 ? v : undefined; };
          return Response.json(await storeUpload(userId, await req.arrayBuffer(), { mime: req.headers.get('content-type') ?? '', name: url.searchParams.get('name') ?? 'file', w: n('w'), h: n('h') }));
        }
        const file = /^\/files\/([0-9a-f-]{36})$/.exec(url.pathname);
        if ((req.method === 'GET' || req.method === 'HEAD') && file) {
          const f = await fileFor(userId, file[1]);
          if (!f) return new Response('Not found', { status: 404 });
          // inline — только то, что браузер покажет как медиа; HTML, SVG и прочее с нашего домена исполнять нельзя
          const safe = INLINE_MIME.test(f.mime);
          const download = url.searchParams.get('download') === '1' || !safe;
          return new Response(Bun.file(f.path), { headers: {
            'content-type': safe ? f.mime : 'application/octet-stream',
            'content-security-policy': "default-src 'none'; sandbox",
            // id — содержимое не меняется: кэшируем навсегда, но только в этом браузере
            'cache-control': 'private, max-age=31536000, immutable',
            'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
            'x-content-type-options': 'nosniff',
          } });
        }
        const media = /^\/chats\/(\d+)\/media$/.exec(url.pathname);
        if (req.method === 'GET' && media) {
          const kind = url.searchParams.get('kind') === 'file' ? 'file' : 'photo';
          const before = Number(url.searchParams.get('beforeId')) || null;
          return Response.json(await getChatMedia(userId, Number(media[1]), kind, before));
        }
        if (url.pathname === '/push/subscription' && (req.method === 'POST' || req.method === 'DELETE')) {
          const body = (await req.json().catch(() => null)) as SubscriptionInput | null;
          if (typeof body?.endpoint !== 'string') return fail('bad_frame');
          if (req.method === 'DELETE') await unsubscribe(userId, body.endpoint);
          else {
            if (typeof body.keys?.p256dh !== 'string' || typeof body.keys?.auth !== 'string') return fail('bad_frame');
            if (body.hideText !== undefined && typeof body.hideText !== 'boolean') return fail('bad_frame');
            try { await subscribe(userId, body, sessionId); } catch { return fail('bad_frame'); }
          }
          return Response.json({ ok: true });
        }
        if (req.method === 'GET' && url.pathname === '/search') {
          // ?q=текст[&chatId=N][&beforeId=M][&limit=K]
          const num = (k: string) => { const v = Number(url.searchParams.get(k)); return Number.isInteger(v) && v > 0 ? v : undefined; };
          return Response.json(await searchMessages(userId, url.searchParams.get('q') ?? '', { chatId: num('chatId'), beforeId: num('beforeId'), limit: num('limit') }));
        }
        if (req.method === 'GET' && url.pathname === '/users') {
          return Response.json({ users: await usersByIds(userId, (url.searchParams.get('ids') ?? '').split(',').map(Number)) });
        }
        if (req.method === 'GET' && url.pathname === '/presence') {
          return Response.json(await listPresence(userId));
        }
        if (req.method === 'GET' && url.pathname === '/chats/page') {
          // страница диалогов: ?limit=100&beforeAt=ISO&beforeId=N (курсор из предыдущей страницы)
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 500);
          const at = url.searchParams.get('beforeAt'), id = url.searchParams.get('beforeId');
          return Response.json(await listChatsPage(userId, limit, at && id ? { at, id: Number(id) } : undefined));
        }
        if (req.method === 'GET' && url.pathname === '/chats') {
          // ?ids=1,2,3 — конкретные чаты; ?unread=1 — все с непрочитанными; без параметров — весь список
          const ids = url.searchParams.get('ids');
          return Response.json(await listChats(userId, {
            ids: ids ? ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500) : undefined,
            unreadOnly: url.searchParams.get('unread') === '1',
          }));
        }
        const hist = /^\/chats\/(\d+)\/messages$/.exec(url.pathname);
        if (req.method === 'GET' && hist) {
          const ids = url.searchParams.get('ids');
          if (ids) return Response.json({ messages: await getMessagesByIds(userId, Number(hist[1]), ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100)) });
          const before = url.searchParams.get('before');
          const limit = Number(url.searchParams.get('limit') ?? 50);
          return Response.json(await getHistory(userId, Number(hist[1]), before ? Number(before) : null, limit));
        }
        return new Response('Not found', { status: 404 });
      } catch (err) {
        if (err instanceof DomainError) return fail(err.code);
        console.error(err);
        return fail('internal');
      }
    })()),
    websocket: {
      open(ws) {
        ws.subscribe(`user:${ws.data.userId}`);
        ws.subscribe(`session:${ws.data.sessionId}`);
        trackSocket(ws.data.sessionId, ws);
        countSocket(ws.data.userId, 1);
        connected(publish, ws.data.userId).catch((err) => console.error('presence:', err));
      },
      close(ws) {
        untrackSocket(ws.data.sessionId, ws);
        countSocket(ws.data.userId, -1);
        disconnected(publish, ws.data.userId);
      },
      async message(ws, raw) {
        const frame = parseClientFrame(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
        if (!frame) {
          ws.send(JSON.stringify({ op: 'err', code: 'bad_frame', retry: false }));
          return;
        }
        // любой кадр (и отправка, и прочтение): раз в минуту — отметка активности и проверка, что сеанс жив;
        // сеанс пропал (NOTIFY мог потеряться) — сокет закрыт, кадр не выполняем
        if (!(await checkSocket(ws.data.sessionId, ws.data).catch(() => true))) return;
        for (const out of await handleFrame(ws.data.userId, frame, publish)) ws.send(JSON.stringify(out));
      },
    },
  });
  return server;
}
