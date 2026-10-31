import { hit } from './valkey';
import { MEDIA_TABS, parseClientFrame, type MediaTab } from '@relay/protocol';
import { getPreview, normalizeUrl } from './domain/linkPreview';
import { searchMedia, searchPeople, topPeers } from './domain/globalSearch';
import { searchChannels } from './domain/channelPreview';
import { createBus } from './bus';
import { clientIp, devAllowed } from './device';
import type { Server } from 'bun';
import { authenticate, clearLegacySessionCookie, clearSessionCookie, createSession, createUser, deleteSession, readSessionToken, sessionCookie, sessionFromToken } from './auth';
import { accessCookie, ACCESS_SEC, clearAccessCookie, deviceKeyOf, newChallenge, refreshAccess, verifyDevice } from './deviceAuth';
import { announceLogin, announceSessionsChanged, assertConfirmed, checkSocket, confirmSession, listSessions, sessionEnded, sweepInactive, terminateOthers, terminateSession, trackSocket, untrackSocket } from './domain/sessions';
import { countViews } from './domain/views';
import { getThread, readThread } from './domain/threads';
import { readBy } from './domain/reads';
import { readReactions, unreadReactions } from './domain/reactionsUnread';
import { commonGroups, deleteDirectChat, createChat, createGroup, GROUP_MEMBERS_MAX, openDirect, messageAtDate, getChatMedia, getMediaDays, getChatMediaCounts, getHistory, getMessagesByIds, listChats, listChatsPage } from './domain/chats';
import { sql } from './db';
import { DomainError } from './domain/errors';
import { setChatNotify } from './domain/chatNotify';
import { setChatFlags, unarchiveByMessage } from './domain/chatFlags';
import { storageUsage } from './domain/uploadLimits';
import { ensureServiceChat } from './domain/service';
import { processAlive } from './domain/liveRegistry';
import { chatMembers, connected, disconnected, listPresence, type Publish } from './domain/presence';
import { searchMessages } from './domain/search';
import { abortUpload, confirmUpload, createUpload, uploadParts, uploadStatus, downloadTtl, fileFor, signedDownload } from './domain/files';
import { resolvePeer, resolvePeers } from './domain/peerRef';
import { initPeerKeys } from './crypto/peerKey';
import { THEMES } from './domain/themes';
import { handleFrame } from './ws';
import { pollVoters } from './domain/polls';
import { mapTile } from './domain/mapTiles';
import { registerSocket, releaseChats, releaseThreads, syncSubscriptions, unregisterSocket } from './sockets';
import { pinMessage, unpinMessage } from './domain/pins';
import { addProfileMusic, listProfileMusic, removeProfileMusic } from './domain/profileMusic';
import { journalStats } from './domain/journal';
import { notifyLatency } from './realtime';
import { checkUsername, getMe, getUser, setUsername, updateProfile, personalChannelCandidates, setPhoto, deletePhoto, setMainPhoto, listPhotos } from './domain/profile';
import { usersByIds } from './domain/users';
import { subscribe, unsubscribe, vapidKeys, type SubscriptionInput } from './domain/push';
import { deleteFolder, getSettings, reorderFolders, saveFolder, setNotify, setPrivacy, setSessionsTtl } from './domain/settings';
import { publicAuthRoute, privateAuthRoute } from './authRoutes';
import { groupRoute } from './groupRoutes';
import { addContact, blockUser, listBlocked, listContacts, removeContact, resolveUser, unblockUser, updateContact } from './domain/contacts';
import { serveEmojiFile, serveReactionFile, serveStickerFile } from './stickers/files';
import { emojiGroupsRoute } from './stickers/groups';
import { reactionsRoute } from './reactions/routes';
import { animatedEmojiRoute } from './reactions/emoji';
import { stickerRoute } from './stickers/routes';

const STATUS: Record<string, number> = { bad_frame: 400, pin_limit: 409, too_long: 400, file_too_big: 413, username_invalid: 400, username_reserved: 400, username_taken: 409, bio_too_long: 400, note_too_long: 400, name_invalid: 400, birthday_invalid: 400, links_invalid: 400, folder_title: 400, folder_empty: 400, folder_too_many_chats: 400, folder_emoji: 400, folders_limit: 400, unauthorized: 401, not_member: 403, blocked: 403, not_found: 404, code_invalid: 400, code_expired: 400, flood: 429, fresh_session: 403, device_invalid: 400, password_invalid: 400, password_missing: 400, recovery_unavailable: 400, email_invalid: 400, qr_expired: 400, passkey_not_found: 404, passkey_invalid: 400, forbidden: 403, upload_missing: 409, upload_mismatch: 400, upload_pending: 409, upload_incomplete: 409, upload_limit: 429, upload_quota: 429, photo_invalid: 400 };
const fail = (code: string, retryAfter?: number) => retryAfter
  ? Response.json({ code, retryAfter }, { status: STATUS[code] ?? 500, headers: { 'retry-after': String(retryAfter) } })
  : Response.json({ code }, { status: STATUS[code] ?? 500 });

/** checkedAt — когда сокет последний раз отмечал активность и проверял свой сеанс (domain/sessions.checkSocket). */
export type WsData = {
  userId: number; sessionId: number; checkedAt: number;
  /** привязанный сеанс: вызов, доказано ли владение ключом, кадры до доказательства */
  challenge?: string; proven?: boolean; queue?: string[]; queuedBytes?: number; proveTimer?: ReturnType<typeof setTimeout>;
  /** допущен: подписан на свои топики и в реестре (привязанный сеанс — только после prove) */
  active?: boolean;
  rate?: { at: number; n: number };
  /** open дошёл до конца (подписки в Valkey, «в сети»): close ждёт его, чтобы «ушёл» не обогнал «пришёл». */
  opened?: Promise<void>;
  /** журналы чатов, на которые подписан сокет (sockets.ts) */
  chats?: Set<number>;
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

/** очередь кадров привязанного сокета до prove — не больше стольких байт (DOS-1) */
const PRE_PROOF_BYTES = 256 * 1024;
/** самый большой кадр клиента (статья ~ десятки КБ): больше — закрытие (DOS-1) */
export const WS_MAX_FRAME = 256 * 1024;
/** кадров в секунду на сокет */
const WS_RATE = 100;
const API = /^\/(health|me|users|contacts|settings|privacy|blocks|chats|presence|search|uploads|files|push|sessions|session|ws|dev|logout|auth|link-preview|groups|join|sticker-sets|my-stickers|stickers-by-emoji|stickers|reactions|animated-emoji|emoji-groups|maptile|themes)(\/|$)/;

export function createServer(opts: { port: number }): Server {
  // кадры мимо журнала — через Valkey, чтобы дошли до сокетов в любом процессе
  const bus = createBus((topic, msg) => { server.publish(topic, msg); });
  const publish: Publish = (topic, msg) => bus.publish(topic, msg);
  /** Кадр WebSocket: разобрать, отметить активность сеанса, выполнить. */
  const runFrame = async (ws: import('bun').ServerWebSocket<WsData>, text: string): Promise<void> => {
    const frame = parseClientFrame(text);
    if (!frame) {
      ws.send(JSON.stringify({ op: 'err', code: 'bad_frame', retry: false }));
      return;
    }
    // любой кадр (и отправка, и прочтение): раз в минуту — отметка активности и проверка, что сеанс жив;
    // сеанс пропал (NOTIFY мог потеряться) — сокет закрыт, кадр не выполняем
    if (!(await checkSocket(ws.data.sessionId, ws.data).catch(() => true))) return;
    for (const out of await handleFrame(ws.data.userId, frame, publish, ws.data.sessionId, ws)) ws.send(JSON.stringify(out));
  };
  const server = Bun.serve<WsData>({
    port: opts.port,
    fetch: async (req, server) => withCookie(req, await (async () => {
      await initPeerKeys();   // секрет ключей доступа к людям (один раз; дальше — готовое обещание). WebSocket приходит сюда же (upgrade)
      const url = new URL(req.url);
      try {
        if (url.pathname === '/health') return Response.json({ ok: true });
        // файлы стикеров и реакций публичные (без сессии); nginx отдаёт их сам, сюда доходят, если его нет
        if (url.pathname.startsWith('/stk/')) return await serveStickerFile(url.pathname, req.method);
        if (url.pathname.startsWith('/rx/')) return await serveReactionFile(url.pathname, req.method);
        if (url.pathname.startsWith('/emj/')) return await serveEmojiFile(url.pathname, req.method);
        // только API: статику клиента раздаёт nginx (docker/nginx), сюда доходит лишь то, чего нет в сборке
        if (!API.test(url.pathname)) return fail('not_found');

        if (devAllowed(req, server) && req.method === 'POST' && url.pathname === '/dev/login') {
          const { name, phone } = (await req.json()) as { name: string; phone?: string };
          // dev: вход по имени — существующий пользователь (в т.ч. из сида) или новый
          const [found] = await sql`select id from users where name = ${String(name ?? '')} and not system order by id limit 1`;
          const userId = found ? (found.id as number) : await createUser(String(name ?? 'user'));
          // dev: телефон нужен только для проверки профиля (SMS-входа нет); занятый номер не мешает входу
          if (typeof phone === 'string') await sql`update users set phone = ${phone} where id = ${userId} and phone is null`.catch(() => {});
          // createSession сам чистит неактивные сеансы и пишет устройство/IP (общий путь для любого входа)
          const token = await createSession(userId, { req, server });
          const h = new Headers();
          h.append('set-cookie', sessionCookie(token)); h.append('set-cookie', clearAccessCookie());   // доступ прежнего сеанса — прочь
          return Response.json({ userId, token }, { headers: h });
        }

        // публичный ключ VAPID — не секрет
        if (req.method === 'GET' && url.pathname === '/push/key') return Response.json({ key: (await vapidKeys()).publicKey });
        const pub = await publicAuthRoute(req, url, server);
        if (pub) return pub;
        // сеанс, привязанный к устройству (deviceAuth.ts): вызов и обновление доступа — по долгому cookie
        if (req.method === 'GET' && url.pathname === '/session/challenge') return Response.json({ nonce: await newChallenge() });
        if (req.method === 'POST' && url.pathname === '/session/refresh') {
          const s = await sessionFromToken(readSessionToken(req));
          if (!s) return fail('unauthorized');
          const token = await refreshAccess(s.sessionId, (await req.json().catch(() => ({}))) as Record<string, unknown>);
          if (!token) return fail('unauthorized');
          return Response.json({ ok: true, expiresIn: ACCESS_SEC }, { headers: { 'set-cookie': accessCookie(token) } });
        }
        const auth = await authenticate(req);
        // привязанный сеанс без свежего доступа: не «сеанс завершён» — клиент обновит доступ и повторит
        // сокет привязанного сеанса — тоже только с коротким доступом (AUTH-1): один украденный долгий cookie
        // не открывает и его. Клиент обновит доступ подписью ключом устройства и подключится снова.
        if (auth === 'refresh') return Response.json({ code: 'access_expired' }, { status: 401, headers: { 'x-relay-auth': 'refresh' } });
        if (!auth) return fail('unauthorized');
        const { userId, sessionId } = auth;
        const priv = await privateAuthRoute(req, url, auth);
        if (priv) return priv;
        const grp = await groupRoute(req, url, userId);
        if (grp) return grp;
        if (auth.refresh) { const t = readSessionToken(req); if (t && req.headers.get('cookie')?.includes('relay_session=')) refreshed.set(req, t); }

        const stk = await stickerRoute(req, url, userId);
        if (stk) return stk;
        const rx = await reactionsRoute(req, url);
        if (rx) return rx;
        const ae = await animatedEmojiRoute(req, url);
        if (ae) return ae;
        const eg = await emojiGroupsRoute(req, url);
        if (eg) return eg;
        // каталог готовых тем (плитки и тема чата): статичный, клиент кэширует
        if (req.method === 'GET' && url.pathname === '/themes') return Response.json({ themes: THEMES }, { headers: { 'cache-control': 'private, max-age=3600' } });
        if (req.method === 'GET' && url.pathname === '/me') {
          await ensureServiceChat(userId).catch((e) => console.warn('service chat', String(e)));   // «Relay» в списке у всех
          return Response.json(await getMe(userId));
        }
        if (req.method === 'PATCH' && url.pathname === '/me') {
          return Response.json(await updateProfile(userId, await req.json().catch(() => null)));
        }
        if (req.method === 'GET' && url.pathname === '/me/personal-channels') return Response.json(await personalChannelCandidates(userId));
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
        const common = /^\/users\/(\d+)\/common-groups$/.exec(url.pathname);
        if (req.method === 'GET' && common) return Response.json({ groups: await commonGroups(userId, Number(common[1])) });
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
        // закрепить / в архив / отметить непрочитанным: { pinned?, archived?, unreadMark? } → все три флага
        const chatFlags = /^\/chats\/(\d{1,15})\/flags$/.exec(url.pathname);
        if (req.method === 'PUT' && chatFlags) return Response.json(await setChatFlags(userId, Number(chatFlags[1]), await req.json().catch(() => null)));
        const chatUnarchive = /^\/chats\/(\d{1,15})\/unarchive$/.exec(url.pathname);
        if (req.method === 'POST' && chatUnarchive) return Response.json(await unarchiveByMessage(userId, Number(chatUnarchive[1]), await req.json().catch(() => null)));
        const chatNotify = /^\/chats\/(\d{1,15})\/notify$/.exec(url.pathname);
        if (req.method === 'PUT' && chatNotify) return Response.json(await setChatNotify(userId, Number(chatNotify[1]), await req.json().catch(() => null)));
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
          const h = new Headers({ 'content-type': 'application/json' });
          h.append('set-cookie', clearSessionCookie()); h.append('set-cookie', clearAccessCookie()); h.append('set-cookie', clearLegacySessionCookie());
          return new Response(JSON.stringify({ ok: true }), { headers: h });
        }
        if (url.pathname === '/ws') {
          // привязанный сеанс: сокет выполняет кадры только после подписи вызова ключом устройства (prove)
          const bound = (await deviceKeyOf(sessionId)) != null;
          return server.upgrade(req, { data: { userId, sessionId, checkedAt: Date.now(), ...(bound ? { challenge: await newChallenge(), proven: false, queue: [] } : {}) } }) ? undefined : fail('bad_frame');
        }
        // новая группа или канал ({kind: 'channel'}; создатель — текущий пользователь) и личный чат с человеком (существующий или новый)
        if (req.method === 'POST' && url.pathname === '/chats') {
          const b = (await req.json().catch(() => ({}))) as { kind?: unknown; title?: unknown; about?: unknown; members?: unknown };
          // участники — ссылками {id, key} (ключ доступа, crypto/peerKey.ts): голый id ничего не открывает
          const memberIds = b.members === undefined ? undefined : await resolvePeers(sql, userId, b.members, GROUP_MEMBERS_MAX, 'members');
          const { chatId } = await createGroup(userId, { kind: b.kind, title: b.title, about: b.about, memberIds });
          return Response.json({ id: chatId });
        }
        if (req.method === 'POST' && url.pathname === '/chats/direct') {
          // {userId, key} или {userId, via: {chatId, messageId}} — человек из сообщения (карточка контакта, «переслано от»)
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          return Response.json({ id: await openDirect(userId, await resolvePeer(sql, userId, body)) });
        }
        if (devAllowed(req, server) && req.method === 'POST' && url.pathname === '/dev/chats') {
          const { kind, title, memberIds } = (await req.json()) as { kind: 'direct' | 'group' | 'channel'; title: string | null; memberIds: number[] };
          const ids = memberIds.includes(userId) ? memberIds : [userId, ...memberIds];
          return Response.json({ id: await createChat(kind, title, ids) });
        }
        if (devAllowed(req, server) && req.method === 'GET' && url.pathname === '/dev/stats') {
          // count(*) по журналу и pg_notify — не чаще раза в devStatsMs на пользователя: повтор получает тот же ответ
          const hit = devStatsCache.get(userId);
          if (hit && Date.now() - hit.at < devStatsMs) return Response.json(await hit.body);
          const body = (async () => {
            const [j, notifyMs, storage] = await Promise.all([journalStats(userId), notifyLatency().catch(() => null), storageUsage(userId)]);
            return { at: Date.now(), userId, seq: j.seq, sockets: userSockets.get(userId) ?? 0, journal: { size: j.size, minSeq: j.minSeq }, notifyMs, storage };
          })();
          devStatsCache.set(userId, { at: Date.now(), body });
          if (devStatsCache.size > 1000) devStatsCache.clear();
          try { return Response.json(await body); } catch (e) { devStatsCache.delete(userId); throw e; }
        }
        if (req.method === 'POST' && url.pathname === '/uploads') {
          // шаг 1: {name, mime, size, w?, h?, kind?, duration?, waveform?, title?, performer?, enc?, key?} → подписанный PUT; сам файл идёт мимо сервера
          // (размеры фото считает клиент, он его уже декодировал; волну и длительность голосового — записывающий клиент)
          const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          if (!b || typeof b !== 'object') return fail('bad_frame');
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
          const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
          return Response.json(await createUpload(userId, { mime: str(b.mime) ?? '', name: str(b.name) ?? 'file', size: typeof b.size === 'number' ? b.size : NaN,
            w: num(b.w), h: num(b.h), kind: str(b.kind), duration: num(b.duration), waveform: str(b.waveform), title: str(b.title), performer: str(b.performer),
            // зашифрован на клиенте: enc 1 и ключ файла (base64) — сервер хранит его завёрнутым KMS
            ...(b.enc === 1 ? { enc: 1, key: str(b.key) } : {}) }));
        }
        // большой файл частями: {parts:[n…]} → подписанные PUT на части; GET — какие части уже приняты; DELETE — отмена
        const parts = /^\/uploads\/([0-9a-f-]{36})\/parts$/.exec(url.pathname);
        if (req.method === 'POST' && parts) return Response.json(await uploadParts(userId, parts[1], ((await req.json().catch(() => null)) as { parts?: unknown } | null)?.parts));
        if (req.method === 'GET' && parts) return Response.json(await uploadStatus(userId, parts[1]));
        const upload = /^\/uploads\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (req.method === 'DELETE' && upload) { await abortUpload(userId, upload[1]); return new Response(null, { status: 204 }); }
        const confirmUp = /^\/uploads\/([0-9a-f-]{36})\/confirm$/.exec(url.pathname);
        if (req.method === 'POST' && confirmUp) return Response.json(await confirmUpload(userId, confirmUp[1]));
        const file = /^\/files\/([0-9a-f-]{36})(?:\/(preview|720|medium))?$/.exec(url.pathname);
        if ((req.method === 'GET' || req.method === 'HEAD') && file) {
          // /files/<id>/preview, /files/<id>/720 — копии видео (jobs/video.ts); preview, medium — копии фото (jobs/photo.ts); ещё нет — 404, клиент берёт оригинал
          const f = await fileFor(userId, file[1], file[2]);
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
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
          return Response.json(await getChatMedia(userId, Number(media[1]), tab, before, limit));
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
        // календарь «Перейти к дате»: по медиа на день за месяц
        const mediaDays = /^\/chats\/(\d+)\/media\/days$/.exec(url.pathname);
        if (req.method === 'GET' && mediaDays) {
          const q = url.searchParams;
          return Response.json({ days: await getMediaDays(userId, Number(mediaDays[1]), q.get('from') ?? '', q.get('to') ?? '', q.get('tz') ?? '') });
        }
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
        if (req.method === 'GET' && url.pathname === '/search/channels') return Response.json(await searchChannels(userId, url.searchParams.get('q') ?? ''));
        if (req.method === 'GET' && url.pathname === '/search/top') return Response.json(await topPeers(userId));
        if (req.method === 'GET' && url.pathname === '/search') {
          // ?q=текст[&chatId=N][&beforeId=M][&limit=K]
          const num = (k: string) => { const v = Number(url.searchParams.get(k)); return Number.isInteger(v) && v > 0 ? v : undefined; };
          return Response.json(await searchMessages(userId, url.searchParams.get('q') ?? '', { chatId: num('chatId'), beforeId: num('beforeId'), limit: num('limit') }));
        }
        if (req.method === 'GET' && url.pathname === '/users') {
          return Response.json(await usersByIds(userId, (url.searchParams.get('ids') ?? '').split(',').map(Number)));
        }
        if (req.method === 'POST' && url.pathname === '/link-preview') {
          // превью ссылки для поля ввода (до отправки): тот же кэш, что и у сообщений; нет превью — { link: null }.
          // POST — адрес в теле, не в строке запроса (не оседает в журналах прокси). Не чаще 30 в минуту на человека
          if ((await hit(`lp:${userId}`, 60)) > 30) return fail('flood');
          const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
          const u = typeof body?.url === 'string' ? normalizeUrl(body.url) : null;
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
          // ?ids=1,2,3 — конкретные чаты; ?unread=1 — все с непрочитанными (и с пометкой); ?pinned=1 — закреплённые; ?archived=1 — архив; без параметров — весь список
          const ids = url.searchParams.get('ids');
          return Response.json(await listChats(userId, {
            ids: ids ? ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500) : undefined,
            unreadOnly: url.searchParams.get('unread') === '1',
            pinnedOnly: url.searchParams.get('pinned') === '1',
            archivedOnly: url.searchParams.get('archived') === '1',
          }));
        }
        // просмотры постов канала: батч id от клиента раз в секунду (views.ts)
        const views = /^\/chats\/(\d+)\/views$/.exec(url.pathname);
        if (req.method === 'POST' && views) {
          const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
          return Response.json(await countViews(userId, Number(views[1]), body?.ids));
        }
        // тред комментариев к посту (группа обсуждения): страница с шапкой и прочитанность (threads.ts)
        const thr = /^\/chats\/(\d+)\/threads\/(\d+)\/(messages|read)$/.exec(url.pathname);
        if (thr && thr[3] === 'messages' && req.method === 'GET') {
          const before = Number(url.searchParams.get('before')), after = Number(url.searchParams.get('after'));
          return Response.json(await getThread(userId, Number(thr[1]), Number(thr[2]), Number.isInteger(before) && before > 0 ? before : null, Number(url.searchParams.get('limit') ?? 50), Number.isInteger(after) && after > 0 ? after : null));
        }
        if (thr && thr[3] === 'read' && req.method === 'PUT') {
          const body = (await req.json().catch(() => null)) as { upToId?: unknown } | null;
          return Response.json(await readThread(userId, Number(thr[1]), Number(thr[2]), body?.upToId));
        }
        // «кто прочитал» своё сообщение в небольшой группе (reads.ts)
        const rb = /^\/chats\/(\d+)\/messages\/(\d+)\/read-by$/.exec(url.pathname);
        if (rb && req.method === 'GET') return Response.json(await readBy(userId, Number(rb[1]), Number(rb[2])));
        // непрочитанные реакции на мои сообщения: самые старые id и «прочитал» (ids — увидел на экране; без ids — все)
        const ur = /^\/chats\/(\d+)\/reactions\/(unread|read)$/.exec(url.pathname);
        if (ur && ur[2] === 'unread' && req.method === 'GET') return Response.json(await unreadReactions(userId, Number(ur[1])));
        if (ur && ur[2] === 'read' && req.method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
          const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200) : undefined;
          return Response.json(await readReactions(userId, Number(ur[1]), ids));
        }
        const mem = /^\/chats\/(\d+)\/members$/.exec(url.pathname);
        if (req.method === 'GET' && mem) return Response.json(await chatMembers(userId, Number(mem[1])));
        // тайл карты для пузыря геопозиции — только вошедшим (не открытый прокси)
        const tile = /^\/maptile\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
        if (req.method === 'GET' && tile) {
          const t = await mapTile(Number(tile[1]), Number(tile[2]), Number(tile[3]));
          return t ? new Response(t.body, { headers: { 'content-type': t.type, 'cache-control': 'private, max-age=604800' } }) : fail('not_found');
        }
        // неанонимный опрос: кто за какой вариант (как «Посмотреть результаты» в Telegram)
        const voters = /^\/chats\/(\d+)\/messages\/(\d+)\/votes$/.exec(url.pathname);
        if (req.method === 'GET' && voters) return Response.json({ options: await pollVoters(userId, Number(voters[1]), Number(voters[2])) });
        const hist = /^\/chats\/(\d+)\/messages$/.exec(url.pathname);
        if (req.method === 'GET' && hist) {
          const from = url.searchParams.get('from');   // «Перейти к дате»
          if (from) return Response.json(await messageAtDate(userId, Number(hist[1]), from));
          const ids = url.searchParams.get('ids');
          if (ids) return Response.json({ messages: await getMessagesByIds(userId, Number(hist[1]), ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100)) });
          const before = url.searchParams.get('before'), after = Number(url.searchParams.get('after'));
          const limit = Number(url.searchParams.get('limit') ?? 50);
          return Response.json(await getHistory(userId, Number(hist[1]), before ? Number(before) : null, limit, Number.isInteger(after) && after > 0 ? after : null));
        }
        return new Response('Not found', { status: 404 });
      } catch (err) {
        if (err instanceof DomainError) return fail(err.code, err.retryAfter);
        console.error(`${req.method} ${url.pathname}:`, err);   // неожиданная ошибка: клиенту — internal, причина — сюда
        return fail('internal');
      }
    })()),
    websocket: {
      maxPayloadLength: WS_MAX_FRAME,   // больше — Bun закрывает сокет сам (по умолчанию было 16 МБ)
      open(ws) {
        // привязанный сеанс: до подписи вызова ключом устройства сокет НИЧЕГО не получает — ни подписок на свои
        // топики, ни регистрации, ни «в сети» (AUTH-1). Всё это — в activate после prove.
        if (ws.data.challenge) {
          ws.send(JSON.stringify({ op: 'challenge', nonce: ws.data.challenge }));
          ws.data.proveTimer = setTimeout(() => { if (!ws.data.proven) ws.close(4401, 'device proof required'); }, 10_000);
          return;
        }
        activate(ws);
      },
      close(ws) {
        if (ws.data.proveTimer) clearTimeout(ws.data.proveTimer);
        if (!ws.data.active) return;   // не дошёл до prove — нечего снимать
        const { userId, sessionId } = ws.data;
        untrackSocket(sessionId, ws);
        countSocket(userId, -1);
        unregisterSocket(ws);
        releaseThreads(ws);
        void (ws.data.opened ?? Promise.resolve()).then(() => {
          disconnected(publish, userId);
          void bus.unlisten(`user:${userId}`).catch((err) => console.error('bus:', err));
          void bus.unlisten(`session:${sessionId}`).catch((err) => console.error('bus:', err));
          void releaseChats(ws);
        });
      },
      async message(ws, raw) {
        // больше WS_RATE кадров в секунду — не клиент, а поток: закрываем (клиент переподключится с паузой) — DOS-1
        const now = Date.now(), rate = (ws.data.rate ??= { at: now, n: 0 });
        if (now - rate.at >= 1000) { rate.at = now; rate.n = 0; }
        if (++rate.n > WS_RATE) { ws.close(4008, 'too many frames'); return; }
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        if (ws.data.challenge && !ws.data.proven) {
          // до подписи ключом устройства выполняется только prove; остальное ждёт (не больше 100 кадров и 256 КБ)
          const f = (() => { try { return JSON.parse(text) as { op?: string; sig?: string }; } catch { return null; } })();
          if (f?.op !== 'prove') {
            ws.data.queuedBytes = (ws.data.queuedBytes ?? 0) + text.length;
            if (ws.data.queue!.length >= 100 || ws.data.queuedBytes > PRE_PROOF_BYTES) { ws.close(4401, 'device proof required'); return; }
            ws.data.queue!.push(text);
            return;
          }
          const spki = await deviceKeyOf(ws.data.sessionId);
          if (!spki || !(await verifyDevice(spki, 'ws', ws.data.challenge, f.sig))) { ws.close(4401, 'device proof failed'); return; }
          ws.data.proven = true;
          clearTimeout(ws.data.proveTimer);
          activate(ws);
          await ws.data.opened;
          for (const q of ws.data.queue!.splice(0)) await runFrame(ws, q);
          return;
        }
        await runFrame(ws, text);
      },
    },
  });
  /** Сокет допущен (не привязанный сеанс — сразу, привязанный — после prove): свои топики, реестр, «в сети», группы. */
  function activate(ws: import('bun').ServerWebSocket<WsData>): void {
    const { userId, sessionId } = ws.data;
    ws.data.active = true;
    ws.subscribe(`user:${userId}`);
    ws.subscribe(`session:${sessionId}`);
    trackSocket(sessionId, ws);
    countSocket(userId, 1);
    registerSocket(ws, bus);
    // подписка в Valkey — до объявления «в сети»: ответные кадры собеседников не должны потеряться.
    // затем журналы групп
    ws.data.opened = Promise.all([bus.listen(`user:${userId}`), bus.listen(`session:${sessionId}`)])
      .catch((err) => console.error('bus:', err))
      .then(() => connected(publish, userId))
      .catch((err) => console.error('presence:', err))
      .then(() => syncSubscriptions(ws))
      .catch((err) => console.error('chat subscriptions:', err));
  }
  // серверы без startRealtime (тесты) тоже считаются живыми для реестра онлайна
  void processAlive().catch((e) => console.error('live registry:', e));
  // остановка сервера закрывает и соединение-подписчик (иначе тесты и процесс не завершатся)
  const stop = server.stop.bind(server);
  server.stop = (async (force?: boolean) => { await bus.close(); return stop(force); }) as typeof server.stop;
  return server;
}
