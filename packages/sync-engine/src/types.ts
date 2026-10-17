import type { Birthday, PrivacyKey, PrivacyMode } from '@relay/protocol';

export type Status = 'pending' | 'sent' | 'read' | 'failed';

export interface LocalMessage {
  key: string;            // = clientId: одинаков у черновика, ack и newMessage
  clientId: string;
  id: number | null;      // null, пока сервер не подтвердил
  chatId: number;
  senderId: number;
  body: string;
  replyToId: number | null;
  createdAt: string;
  status: Status;
  sort: number;           // id, а у неподтверждённых — PENDING_BASE + время создания
  editedAt?: string | null;
  deleted?: boolean;
  reactions?: { userId: number; emoji: string }[];
  kind?: 'text' | 'photo' | 'file';
  attachment?: LocalAttachment | null;
  progress?: number;      // загрузка файла 0..1, пока сообщение в очереди
  error?: string;         // почему не отправлено (failed): 'blocked' — собеседник заблокировал отправителя
}

/** Вложение сообщения; у неотправленного id пустой, пока файл не загружен. */
export interface LocalAttachment { id: string; kind: 'photo' | 'file'; mime: string; name: string; size: number; w: number | null; h: number | null; thumb?: string | null }

export interface LocalChat {
  id: number;
  kind: 'direct' | 'group';
  title: string | null;
  lastReadId: number;
  unread: number;
  knownMaxId: number;     // максимальный id сообщения, который уже учтён в unread
  peerReadUpTo: number;   // до какого id собеседники прочитали мои сообщения
  historyComplete: boolean;
  peerId: number | null;  // собеседник личного чата
  named: boolean;         // название пришло со снимка (иначе чат узнали из сообщения)
  last: LocalMessage | null;
  lastAt: string;
  draft?: { text: string; at: string } | null;   // неотправленный текст композера (общий для вкладок)
}

export interface OutboxEntry {
  clientId: string;
  chatId: number;
  body: string;
  replyToId: number | null;
  createdAt: number;
  failed: boolean;
  attachment?: LocalAttachment | null;   // id появляется после загрузки файла
  error?: string;         // код отказа сервера (failed)
}

export type Query =
  | { kind: 'chatList'; limit: number }
  /** Окно ленты: без якоря — последние limit (живой хвост); с якорем — limit сообщений, которые
   *  заканчиваются на sort (end), начинаются с него (start) или стоят вокруг него (center). */
  | { kind: 'messages'; chatId: number; limit: number; anchor?: { sort: number; side: 'end' | 'start' | 'center' } }
  | { kind: 'counters' }
  | { kind: 'status' }
  | { kind: 'presence'; userId: number }
  /** свой профиль (с ещё не подтверждёнными правками) */
  | { kind: 'me' }
  /** профиль человека (PublicUser); нет в кэше — движок подгрузит */
  | { kind: 'user'; userId: number }
  /** очередь операций настроек: сколько ждёт и последние отказы сервера (opFailed) */
  | { kind: 'ops' }
  /** контакты (с ещё не подтверждёнными правками), с профилем и присутствием */
  | { kind: 'contacts' }
  /** настройки аккаунта (с ещё не подтверждёнными правками): один элемент {notify, sessionsTtlDays, loaded, pending} */
  | { kind: 'settings' }
  /** чёрный список (с ещё не подтверждёнными правками), новые сверху; служебный ~blocked {loaded} */
  | { kind: 'blocked' }
  /** раздел «Для разработчиков»: один элемент devStats — снимок состояния движка, не чаще раза в секунду */
  | { kind: 'devStats' }
  /** журнал движка (devlog.ts): снимок — события новее since, дальше — только новые, пачкой раз в 250 мс */
  | { kind: 'devLog'; since: number };

export type Item = { key: string } & Record<string, unknown>;

export type Patch =
  | { op: 'snapshot'; items: Item[]; order: string[] }
  | { op: 'diff'; upsert: Item[]; remove: string[]; order?: string[] };

export type Action =
  | { type: 'sendMessage'; chatId: number; body: string; replyToId?: number | null }
  | { type: 'seen'; chatId: number; upToId: number }
  | { type: 'loadOlder'; chatId: number }
  | { type: 'retry'; clientId: string }
  | { type: 'refreshChats' }
  | { type: 'loadMoreChats' }
  | { type: 'setDraft'; chatId: number; text: string }
  | { type: 'typing'; chatId: number }
  | { type: 'editMessage'; chatId: number; id: number; body: string }
  | { type: 'deleteMessage'; chatId: number; id: number }
  | { type: 'react'; chatId: number; id: number; emoji: string | null }
  | { type: 'search'; q: string; chatId?: number; beforeId?: number; limit?: number }
  | { type: 'chatMedia'; chatId: number; kind: 'photo' | 'file' }
  | { type: 'updateProfile'; firstName?: string; lastName?: string; bio?: string | null; birthday?: Birthday | null }
  | { type: 'setUsername'; username: string | null }
  /** проверка имени пользователя мимо очереди: {ok} | {ok:false, reason} | {offline:true} */
  | { type: 'checkUsername'; username: string }
  /** контакты — через очередь операций (видно сразу, в том числе без сети) */
  | { type: 'addContact'; userId: number; firstName: string; lastName?: string; note?: string }
  | { type: 'updateContact'; userId: number; firstName?: string; lastName?: string; note?: string }
  | { type: 'removeContact'; userId: number }
  /** найти человека по @имени или номеру мимо очереди: {user} | {notFound:true} | {offline:true} */
  | { type: 'resolveUser'; query: string }
  /** умолчания уведомлений для вида чата — через очередь операций (видно сразу, в том числе без сети) */
  /** перезапросить настройки с сервера (предзагрузка раздела) */
  | { type: 'refreshSettings' }
  | { type: 'setNotify'; notifyType: 'direct' | 'group'; muted?: boolean; preview?: boolean }
  /** правило конфиденциальности целиком — через очередь операций */
  | { type: 'setPrivacy'; key: PrivacyKey; mode: PrivacyMode; allow?: number[]; deny?: number[] }
  /** чёрный список — через очередь операций */
  | { type: 'block'; userId: number }
  | { type: 'unblock'; userId: number }
  /** активные сеансы с сервера мимо кэша: {sessions} (без тех, чьё завершение ещё в очереди) | {offline:true} */
  | { type: 'listSessions' }
  /** завершить сеанс / все другие — через очередь операций */
  | { type: 'terminateSession'; id: number }
  | { type: 'terminateOtherSessions' }
  /** срок автозавершения неактивных сеансов, дней (7 | 30 | 90 | 180 | 365) — через очередь операций */
  | { type: 'setSessionsTtl'; days: number }
  /** стереть локальные данные и взять снимок заново; keepOutbox — не трогать неотправленное */
  | { type: 'resetLocal'; keepOutbox?: boolean }
  /** раздел «Для разработчиков»: имитатор сети и служебные команды (devlog.ts) */
  | DevAction
  | { type: 'sendFile'; chatId: number; body: string; file: Blob; name: string; mime: string; w?: number | null; h?: number | null; thumb?: string | null; replyToId?: number | null };

/** Медленная сеть: задержка (мс, туда-обратно; на каждое направление — половина), джиттер (мс), потери кадров (%), полоса (Кбит/с, 0 — без ограничения). */
export interface NetProfile { latency: number; jitter: number; lossPct: number; kbps: number }

/** Команды раздела «Для разработчиков». persist — режим сети переживёт перезапуск (хранится в IDB meta). */
export type DevAction =
  | { type: 'dev'; cmd: 'offline'; args: { on: boolean; persist?: boolean } }
  | { type: 'dev'; cmd: 'netProfile'; args: { profile: NetProfile | null; persist?: boolean } }
  | { type: 'dev'; cmd: 'persist'; args: { on: boolean } }
  | { type: 'dev'; cmd: 'dropSocket' | 'dropNextUpdates' | 'forceTooLong' | 'resync' | 'restartWorker' | 'retryFailed' | 'discardFailed' | 'clearLog'; args?: undefined };

export interface EngineConfig {
  /** сколько resetLocal ждёт идущую работу, мс (по умолчанию 8000) */
  resetWaitMs?: number;
  userId: number;
  dbName: string;
  httpBase: string;
  wsUrl: string;
  /** Только сериализуемое: конфиг уходит в воркер через postMessage. В браузере не нужен — cookie сессии уходит сам. */
  headers?: Record<string, string>;
  frameMs?: number;
  readFlushMs?: number;
  backoffMs?: [number, number];
  historyPage?: number;
  dialogsPage?: number;
  /** сколько ждать ответ на sync, прежде чем спросить тот же диапазон ещё раз (по умолчанию 5000) */
  syncTimeoutMs?: number;
  /** сколько ждать ack/err на запрос с reqId; без ответа соединение считается мёртвым (по умолчанию 15000) */
  requestTimeoutMs?: number;
  typingMs?: number;      // сколько держать «печатает…» после последнего кадра (по умолчанию 6000)   // диалогов в странице (по умолчанию 100)
}

export const PENDING_BASE = 2 ** 52;

/** Результат поиска: сообщение и где оно (для перехода). source — откуда ответ (без сети ищем локально). */
export interface SearchHit { chatId: number; chatTitle: string | null; id: number; sort: number; senderId: number; body: string; createdAt: string }
export interface SearchResult { hits: SearchHit[]; hasMore: boolean; source: 'server' | 'local' }
