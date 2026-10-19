import { MEDIA_TABS, parseClientFrame, type MediaTab } from '@relay/protocol';
import { getPreview, normalizeUrl } from './domain/linkPreview';
import { searchMedia, searchPeople, topPeers } from './domain/globalSearch';
import { createBus } from './bus';
import { clientIp } from './device';
import type { Server } from 'bun';
import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { clearSessionCookie, createSession, createUser, deleteSession, readSessionToken, sessionCookie, sessionFromToken } from './auth';
import { announceLogin, announceSessionsChanged, assertConfirmed, checkSocket, confirmSession, listSessions, sessionEnded, sweepInactive, terminateOthers, terminateSession, trackSocket, untrackSocket } from './domain/sessions';
import { deleteDirectChat, createChat, createGroup, openDirect, messageAtDate, getChatMedia, getChatMediaCounts, getHistory, getMessagesByIds, listChats, listChatsPage } from './domain/chats';
import { sql } from './db';
import { DomainError } from './domain/errors';
import { ensureServiceChat } from './domain/service';
import { processAlive } from './domain/liveRegistry';
import { chatMembers, connected, disconnected, listPresence, type Publish } from './domain/presence';
import { searchMessages } from './domain/search';
import { confirmUpload, createUpload, downloadTtl, fileFor, signedDownload } from './domain/files';
import { handleFrame } from './ws';
import { pinMessage, unpinMessage } from './domain/pins';
import { addProfileMusic, listProfileMusic, removeProfileMusic } from './domain/profileMusic';
import { journalStats } from './domain/journal';
import { notifyLatency } from './realtime';
import { checkUsername, getMe, getUser, setUsername, updateProfile, setPhoto, deletePhoto, setMainPhoto, listPhotos } from './domain/profile';
import { usersByIds } from './domain/users';
import { subscribe, unsubscribe, vapidKeys, type SubscriptionInput } from './domain/push';
import { deleteFolder, getSettings, reorderFolders, saveFolder, setNotify, setPrivacy, setSessionsTtl } from './domain/settings';
import { publicAuthRoute, privateAuthRoute } from './authRoutes';
import { groupRoute } from './groupRoutes';
import { addContact, blockUser, listBlocked, listContacts, removeContact, resolveUser, unblockUser, updateContact } from './domain/contacts';

const STATUS: Record<string, number> = { bad_frame: 400, too_long: 400, username_invalid: 400, username_reserved: 400, username_taken: 409, bio_too_long: 400, note_too_long: 400, name_invalid: 400, birthday_invalid: 400, links_invalid: 400, folder_title: 400, folder_empty: 400, folder_too_many_chats: 400, folder_emoji: 400, folders_limit: 400, unauthorized: 401, not_member: 403, blocked: 403, not_found: 404, code_invalid: 400, code_expired: 400, flood: 429, fresh_session: 403, password_invalid: 400, password_missing: 400, recovery_unavailable: 400, email_invalid: 400, qr_expired: 400, passkey_not_found: 404, passkey_invalid: 400, forbidden: 403, upload_missing: 409, upload_mismatch: 400, upload_pending: 409, photo_invalid: 400 };
const fail = (code: string) => Response.json({ code }, { status: STATUS[code] ?? 500 });

/** checkedAt — когда сокет последний раз отмечал активность и проверял свой сеанс (domain/sessions.checkSocket). */
export type WsData = {
  userId: number; sessionId: number; checkedAt: number;
  /** open дошёл до конца (подписки в Valkey, «в сети»): close ждёт его, чтобы «ушёл» не обогнал «пришёл». */
  opened?: Promise<void>;
};

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

const API = /^\/(health|me|users|contacts|settings|privacy|blocks|chats|presence|search|uploads|files|push|sessions|ws|dev|logout|auth|link-preview|groups|join)(\/|$)/;

/** Статика клиента из WEB_DIST. Путь не может выйти за папку; пути без расширения — SPA, отдаём index.html. */
function serveStatic(pathname: string, acceptEncoding = ''): Response {
  const dist = resolve(process.env.WEB_DIST ?? join(import.meta.dir, '..', '..', 'web', 'dist'));
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return new Response('Bad request', { status: 400 }); }
  const file = resolve(dist, '.' + (decoded === '/' ? '/index.html' : decoded));
  const inside = file === dist || file.startsWith(dist + sep);
  if (inside && existsSync(file) && statSync(file).isFile()) {
    // рядом лежит сжатая копия (узоры обоев: .svg.gz) и браузер принимает gzip — отдаём её, тип — от исходного файла
    const gz = file + '.gz';
    const zipped = /\bgzip\b/.test(acceptEncoding) && existsSync(gz);
    const res = new Response(Bun.file(zipped ? gz : file), { headers: { 'content-type': Bun.file(file).type, vary: 'accept-encoding' } });
    if (zipped) res.headers.set('content-encoding', 'gzip');
    // узоры не меняются между сборками (новый узор — новое имя); остальное без хэша в имени: браузер обязан перепроверять
    res.headers.set('cache-control', decoded.startsWith('/patterns/') ? 'public, max-age=604800' : 'no-cache');
    return res;
  }
  if (!extname(decoded) && existsSync(join(dist, 'index.html'))) {
    return new Response(Bun.file(join(dist, 'index.html')), { headers: { 'cache-control': 'no-cache' } });
  }
  return new Response('Not found', { status: 404 });
}

export function createServer(opts: { port: number }): Server {
  // кадры мимо журнала — через Valkey, чтобы дошли до сокетов в любом процессе
  const bus = createBus((topic, msg) => { server.publish(topic, msg); });
  const publish: Publish = (topic, msg) => bus.publish(topic, msg);
  const server = Bun.serve<WsData>({
    port: opts.port,
    fetch: async (req, server) => withCookie(req, await (async () => {
      const url = new URL(req.url);
      try {
        if (url.pathname === '/health') return Response.json({ ok: true });
        if ((req.method === 'GET' || req.method === 'HEAD') && !API.test(url.pathname)) return serveStatic(url.pathname, req.headers.get('accept-encoding') ?? '');

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
        const pub = await publicAuthRoute(req, url, server);
        if (pub) return pub;
        const auth = await sessionFromToken(readSessionToken(req));
        if (!auth) return fail('unauthorized');
        const { userId, sessionId } = auth;
        const priv = await privateAuthRoute(req, url, auth);
        if (priv) return priv;
        const grp = await groupRoute(req, url, userId);
        if (grp) return grp;
        if (auth.refresh) { const t = readSessionToken(req); if (t && req.headers.get('cookie')?.includes('relay_session=')) refreshed.set(req, t); }

        if (req.method === 'GET' && url.pathname === '/me') {
          await ensureServiceChat(userId).catch((e) => console.warn('service chat', String(e)));   // «Relay» в списке у всех
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
        if (url.pathname === '/me/photo') {
          if (req.method === 'PUT') return Response.json(await setPhoto(userId, await req.json().catch(() => null)));
          if (req.method === 'DELETE') return Response.json(await deletePhoto(userId));
        }
        const myPhoto = /^\/me\/photos\/(\d{1,15})(\/main)?$/.exec(url.pathname);
        if (myPhoto && req.method === 'DELETE' && !myPhoto[2]) return Response.json(await deletePhoto(userId, Number(myPhoto[1])));
        if (myPhoto && req.method === 'PUT' && myPhoto[2]) return Response.json(await setMainPhoto(userId, Number(myPhoto[1])));
        const photos = /^\/users\/(\d{1,15})\/photos$/.exec(url.pathname);
        if (photos && req.method === 'GET') return Response.json(await listPhotos(userId, Number(photos[1]), Number(url.searchParams.get('offset') ?? 0) || 0, Number(url.searchParams.get('limit') ?? 50) || 50));
        const music = /^\/users\/(\d{1,15})\/music$/.exec(url.pathname);
        if (req.method === 'GET' && music) return Response.json({ tracks: await listProfileMusic(userId, Number(music[1])) });
        if (req.method === 'POST' && url.pathname === '/me/music') {
          const body = (await req.json().catch(() => null)) as { chatId?: unknown; messageId?: unknown } | null;
          if (!Number.isSafeInteger(body?.chatId) || !Number.isSafeInteger(body?.messageId)) return fail('bad_frame');
          return Response.json({ tracks: await addProfileMusic(userId, body!.chatId as number, body!.messageId as number) });
        }
        const myTrack = /^\/me\/music\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (req.method === 'DELETE' && myTrack) return Response.json({ tracks: await removeProfileMusic(userId, myTrack[1]) });
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
        if (req.method === 'PUT' && url.pathname === '/settings/folders/order') return Response.json(await reorderFolders(userId, await req.json().catch(() => null)));
        const folder = /^\/settings\/folders\/(\d{1,7})$/.exec(url.pathname);
        if (folder && req.method === 'PUT') return Response.json(await saveFolder(userId, Number(folder[1]), await req.json().catch(() => null)));
        if (folder && req.method === 'DELETE') return Response.json(await deleteFolder(userId, Number(folder[1])));
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
        // новая группа (создатель — текущий пользователь) и личный чат с человеком (существующий или новый)
        if (req.method === 'POST' && url.pathname === '/chats') {
          const { chatId } = await createGroup(userId, (await req.json().catch(() => ({}))) as { title?: unknown; memberIds?: unknown });
          return Response.json({ id: chatId });
        }
        if (req.method === 'POST' && url.pathname === '/chats/direct') {
          const body = (await req.json().catch(() => ({}))) as { userId?: unknown };
          return Response.json({ id: await openDirect(userId, body.userId) });
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
        if (req.method === 'POST' && url.pathname === '/uploads') {
          // шаг 1: {name, mime, size, w?, h?, kind?, duration?, waveform?, title?, performer?} → подписанный PUT; сам файл идёт мимо сервера
          // (размеры фото считает клиент, он его уже декодировал; волну и длительность голосового — записывающий клиент)
          const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          if (!b || typeof b !== 'object') return fail('bad_frame');
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
          const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
          return Response.json(await createUpload(userId, { mime: str(b.mime) ?? '', name: str(b.name) ?? 'file', size: typeof b.size === 'number' ? b.size : NaN,
            w: num(b.w), h: num(b.h), kind: str(b.kind), duration: num(b.duration), waveform: str(b.waveform), title: str(b.title), performer: str(b.performer) }));
        }
        const confirmUp = /^\/uploads\/([0-9a-f-]{36})\/confirm$/.exec(url.pathname);
        if (req.method === 'POST' && confirmUp) return Response.json(await confirmUpload(userId, confirmUp[1]));
        const file = /^\/files\/([0-9a-f-]{36})$/.exec(url.pathname);
        if ((req.method === 'GET' || req.method === 'HEAD') && file) {
          const f = await fileFor(userId, file[1]);
          if (!f) return new Response('Not found', { status: 404 });
          // inline — только то, что браузер покажет как медиа; HTML, SVG и прочее отдаём вложением как octet-stream
          const inline = INLINE_MIME.test(f.mime) && url.searchParams.get('download') !== '1';
          // ссылка живёт минуты: редирект кэшируем вдвое короче, чтобы браузер не пошёл по уже истёкшей
          return new Response(null, { status: 302, headers: {
            location: signedDownload(f, { inline }),
            'cache-control': `private, max-age=${Math.floor(downloadTtl() / 2)}`,
            'referrer-policy': 'no-referrer',
          } });
        }
        const media = /^\/chats\/(\d+)\/media$/.exec(url.pathname);
        if (req.method === 'GET' && media) {
          const raw = url.searchParams.get('kind');
          const tab: MediaTab = raw === 'photo' ? 'media' : (MEDIA_TABS as readonly string[]).includes(raw ?? '') ? raw as MediaTab : 'media';   // photo — прежнее имя вкладки
          const before = Number(url.searchParams.get('beforeId')) || null;
          return Response.json(await getChatMedia(userId, Number(media[1]), tab, before));
        }
        const del = /^\/chats\/(\d+)\/delete$/.exec(url.pathname);
        if (del && req.method === 'POST') {
          const body = await req.json().catch(() => null) as { forAll?: unknown } | null;
          return Response.json(await deleteDirectChat(userId, Number(del[1]), body?.forAll === true));
        }
        const pins = /^\/chats\/(\d+)\/pins(?:\/(\d+))?$/.exec(url.pathname);
        if (pins && req.method === 'POST' && !pins[2]) {
          const body = (await req.json().catch(() => null)) as { messageId?: unknown } | null;
          if (!Number.isSafeInteger(body?.messageId)) return fail('bad_frame');
          return Response.json(await pinMessage(userId, Number(pins[1]), body!.messageId as number));
        }
        if (pins && req.method === 'DELETE') return Response.json(await unpinMessage(userId, Number(pins[1]), pins[2] ? Number(pins[2]) : null));
        const mediaCounts = /^\/chats\/(\d+)\/media\/counts$/.exec(url.pathname);
        if (req.method === 'GET' && mediaCounts) return Response.json(await getChatMediaCounts(userId, Number(mediaCounts[1])));
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
        // глобальный поиск: вкладки медиа по всем чатам, люди, частые собеседники
        if (req.method === 'GET' && url.pathname === '/search/media') {
          const kind = url.searchParams.get('kind') as MediaTab;
          if (!MEDIA_TABS.includes(kind)) return fail('bad_frame');
          const before = Number(url.searchParams.get('before'));
          return Response.json(await searchMedia(userId, kind, { q: url.searchParams.get('q') ?? '', before: Number.isInteger(before) && before > 0 ? before : undefined }));
        }
        if (req.method === 'GET' && url.pathname === '/search/people') return Response.json(await searchPeople(userId, url.searchParams.get('q') ?? ''));
        if (req.method === 'GET' && url.pathname === '/search/top') return Response.json(await topPeers(userId));
        if (req.method === 'GET' && url.pathname === '/search') {
          // ?q=текст[&chatId=N][&beforeId=M][&limit=K]
          const num = (k: string) => { const v = Number(url.searchParams.get(k)); return Number.isInteger(v) && v > 0 ? v : undefined; };
          return Response.json(await searchMessages(userId, url.searchParams.get('q') ?? '', { chatId: num('chatId'), beforeId: num('beforeId'), limit: num('limit') }));
        }
        if (req.method === 'GET' && url.pathname === '/users') {
          return Response.json({ users: await usersByIds(userId, (url.searchParams.get('ids') ?? '').split(',').map(Number)) });
        }
        if (req.method === 'GET' && url.pathname === '/link-preview') {
          // превью ссылки для поля ввода (до отправки): тот же кэш, что и у сообщений; нет превью — { link: null }
          const u = normalizeUrl(url.searchParams.get('url') ?? '');
          return Response.json({ link: u ? await getPreview(u) : null });
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
        const mem = /^\/chats\/(\d+)\/members$/.exec(url.pathname);
        if (req.method === 'GET' && mem) return Response.json(await chatMembers(userId, Number(mem[1])));
        const hist = /^\/chats\/(\d+)\/messages$/.exec(url.pathname);
        if (req.method === 'GET' && hist) {
          const from = url.searchParams.get('from');   // «Перейти к дате»
          if (from) return Response.json(await messageAtDate(userId, Number(hist[1]), from));
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
        const { userId, sessionId } = ws.data;
        ws.subscribe(`user:${userId}`);
        ws.subscribe(`session:${sessionId}`);
        trackSocket(sessionId, ws);
        countSocket(userId, 1);
        // подписка в Valkey — до объявления «в сети»: ответные кадры собеседников не должны потеряться
        ws.data.opened = Promise.all([bus.listen(`user:${userId}`), bus.listen(`session:${sessionId}`)])
          .catch((err) => console.error('bus:', err))
          .then(() => connected(publish, userId))
          .catch((err) => console.error('presence:', err));
      },
      close(ws) {
        const { userId, sessionId } = ws.data;
        untrackSocket(sessionId, ws);
        countSocket(userId, -1);
        void (ws.data.opened ?? Promise.resolve()).then(() => {
          disconnected(publish, userId);
          void bus.unlisten(`user:${userId}`).catch((err) => console.error('bus:', err));
          void bus.unlisten(`session:${sessionId}`).catch((err) => console.error('bus:', err));
        });
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
  // серверы без startRealtime (тесты) тоже считаются живыми для реестра онлайна
  void processAlive().catch((e) => console.error('live registry:', e));
  // остановка сервера закрывает и соединение-подписчик (иначе тесты и процесс не завершатся)
  const stop = server.stop.bind(server);
  server.stop = (async (force?: boolean) => { await bus.close(); return stop(force); }) as typeof server.stop;
  return server;
}
