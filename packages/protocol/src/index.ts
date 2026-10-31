import type { Block } from './blocks';
import type { ProfileLink } from './links';
export * from './links';
export * from './emoji';
export * from './folders';
import type { ChatFolder } from './folders';
import type { GroupInfo, MyMembership } from './groups';

export type Id = number;

/** Служебное сообщение от системного пользователя: машинный тип для отрисовки и склейки повторов. */
export type ServiceType = 'login_code' | 'new_login' | 'group_created' | 'channel_created' | 'welcome'
  | 'title_changed' | 'photo_changed' | 'photo_removed' | 'members_added' | 'member_left' | 'member_removed'
  | 'joined_by_link' | 'joined_by_request' | 'owner_changed' | 'protected_on' | 'protected_off'
  | 'todo_done' | 'todo_append';   // чек-лист: автор отметил / добавил задачи в список replyToId (номера — в data)
/** Участники служебного события (имена на момент события), новое название и новое фото (photo_changed). */
export interface ServiceData { users?: { id: Id; name: string }[]; title?: string; completed?: number[]; incompleted?: number[]; items?: number[]; photo?: ProfilePhoto }   // group_created / channel_created: тело — название, автор — создатель

export interface Message {
  id: Id;
  chatId: Id;
  senderId: Id;
  clientId: string;
  kind: 'text' | 'photo' | 'video' | 'file' | 'voice' | 'round' | 'audio' | 'todo' | 'sticker' | 'poll' | 'contact' | 'geo' | 'dice';
  groupId?: string | null;   // отправлены вместе (несколько файлов) — в ленте одним пузырём
  body: string;
  replyToId: Id | null;
  createdAt: string; // ISO
  editedAt?: string | null;
  deleted?: boolean;
  reactions?: Reaction[];
  attachment?: Attachment | null;
  service?: { type: ServiceType; data?: ServiceData };   // есть только у служебных сообщений
  todo?: Todo;           // чек-лист (kind 'todo'): задачи и кто что отметил
  poll?: Poll;           // опрос или викторина (kind 'poll'): счётчики и мои голоса — для этого читателя
  contact?: ContactCard; // kind 'contact': пользователь Relay, которым поделились
  geo?: GeoPoint;        // kind 'geo': точка на карте (с названием — место)
  dice?: Dice;           // kind 'dice': эмодзи и выпавшее значение
  entities?: Entity[];   // оформление текста; нет или пусто — простой текст
  listened?: boolean;    // голосовое/кружок прослушан получателем
  fwdFrom?: ForwardInfo | null;   // переслано: откуда (нет — своё или отправитель скрыт)
  link?: LinkPreview | null;      // превью первой ссылки в тексте (pending — сервер ещё загружает страницу)
  blocks?: Block[] | null;        // «статья»: блоки (body — её простой текст)
  buttons?: MessageButton[][] | null;   // кнопки под сообщением (как inline-клавиатура в Telegram): ряды слева направо
  sticker?: StickerRef | null;          // kind 'sticker': снимок стикера на момент отправки
  post?: boolean;        // пост канала: автор — канал (senderId 0), наружу автор не раскрывается
  postAuthor?: string;   // подпись автора поста (если в канале включены подписи)
  views?: number;        // просмотры поста (история, поиск, строка списка; в журнале нет — клиент держит своё значение)
  reactionCounts?: [string, number][];   // реакции поста счётчиками: [эмодзи, сколько], больше — раньше (вместо reactions)
  myReaction?: string;   // моя реакция на пост (кто ещё поставил — у поста не отдаётся)
  threadId?: Id;         // комментарий: id копии поста в группе обсуждения (корень треда)
  origin?: { chatId: Id; id: Id };   // копия поста в группе обсуждения: канал и пост-оригинал (управляется только через пост)
  replies?: Replies;     // пост канала с обсуждением: кнопка «N комментариев» (только история канала, в журнале нет)
}

/** Комментарии к посту: тред — копия copyId в группе chatId; recent — последние (до 3) комментаторы, свежий первым.
 *  readMaxId — докуда я прочитал тред (только в истории канала; нет — не читал). */
export interface Replies { copyId: Id; chatId: Id; count: number; lastId: Id | null; recent: Id[]; readMaxId?: Id }

/** Стикер: всё, чтобы нарисовать его без запросов (url — неизменяемый файл /stk/<пак>/<хэш>/<файл>). */
export interface StickerRef { id: Id; setId: Id; emoji: string; w: number; h: number; format: 'tgs' | 'webp' | 'json'; url: string; outline: string | null }
/** Пак без списка стикеров (строки списков, полоса обложек). */
export interface StickerSetInfo { id: Id; shortName: string; title: string; kind: 'sticker' | 'emoji'; count: number; cover: StickerRef | null; hash: string }
export interface StickerSet extends StickerSetInfo { stickers: StickerRef[] }
/** Мои стикеры: установленные паки по порядку, недавние (до 20) и избранные (до 5), новые сверху. */
export interface MyStickers { sets: StickerSetInfo[]; recent: StickerRef[]; faved: StickerRef[] }
export const RECENT_STICKERS_LIMIT = 20;
export const FAVED_STICKERS_LIMIT = 5;

/**
 * Кнопка под сообщением. callback — нажатие уходит на сервер (кадр button с data), ответ — тост и, может быть,
 * правка сообщения (кнопки убираются, в текст — итог); url — открыть ссылку. Пока кнопки шлёт только «Relay».
 */
export interface MessageButton { text: string; kind: 'callback' | 'url'; data?: string; url?: string }
export const BUTTON_DATA_MAX = 64;

/** Превью ссылки: сайт, заголовок, описание и картинка (уже в нашем хранилище: /files/<id>). */
export interface LinkPreview {
  url: string;
  pending?: boolean;
  siteName?: string | null; title?: string | null; description?: string | null;
  photo?: { id: string; w: number; h: number } | null;
}

/** Откуда пересланное: исходный автор (имя — на момент пересылки), чат и сообщение оригинала, когда оно написано. */
/** Переслан пост канала: userId null, name — название канала (автор не раскрывается), postAuthor — подпись поста. */
export interface ForwardInfo { userId: Id | null; name: string; chatId: Id; messageId: Id; at: string; postAuthor?: string; photo?: ProfilePhoto | null }   // userId null — от канала (photo — его фото на момент пересылки)
/** Ссылка на пересылаемое в кадре send: сервер сам берёт текст, оформление и вложение оригинала. */
export interface ForwardRef { chatId: Id; id: Id; hideSender?: boolean; hideCaption?: boolean }

/** Оформление куска текста: смещения в единицах UTF-16 (как String.length). Один тип сам с собой не перекрывается. */
export type EntityType = 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler' | 'code' | 'pre' | 'link' | 'date';
/** date — дата и время (как messageEntityFormattedDate в Telegram): date — unix-секунды, format — как показывать:
 *  'r' — относительно («завтра в 10:00»), иначе по порядку w (день недели), d / D (дата коротко / полностью),
 *  t / T (время коротко / с секундами); пусто — показать текст сообщения как есть. */
export interface Entity { type: EntityType; offset: number; length: number; url?: string; date?: number; format?: string }
export const DATE_FORMAT = /^(r|w?[dD]?[tT]?)$/;
export const ENTITY_TYPES: readonly EntityType[] = ['bold', 'italic', 'underline', 'strike', 'spoiler', 'code', 'pre', 'link', 'date'];
export const MAX_ENTITIES = 100;
/** Пачка кликов по большому эмодзи: не больше кликов и секунд от первого (как в Telegram — окно в секунду). */
export const EMOJI_FX_MAX = 10;
export const EMOJI_FX_WINDOW_S = 10;

/** Адрес ссылки, который можно показать: http(s) или mailto, без пробелов, до 2048 символов. */
export function entityUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 2048 || /\s/.test(s)) return null;
  return /^(https?:\/\/[^/?#\s]+|mailto:[^@\s]+@)/i.test(s) ? s : null;
}

/**
 * Проверка оформления от клиента: только известные типы и целые смещения в пределах текста, ссылки — безопасные,
 * один тип склеивается сам с собой, не больше MAX_ENTITIES. Мусор отбрасывается, а не превращается в ошибку.
 */
/**
 * Черновик, который забирает отправка (кадр send, draftHash): SHA-256 его текста в hex. Отправка без сети доходит до
 * сервера позже — за это время на устройстве мог появиться новый черновик; сервер стирает черновик чата, только если
 * его текст — тот же, что был в момент отправки. null — отправка черновик не трогает (стикер, чек-лист, пересылка без
 * подписи); поля нет (старый клиент) — сервер стирает всегда, как раньше.
 */
export async function draftHash(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeEntities(text: string, raw: unknown): Entity[] {
  if (!Array.isArray(raw)) return [];
  const by = new Map<string, Entity[]>();
  for (const e of raw.slice(0, MAX_ENTITIES * 2)) {
    if (!e || typeof e !== 'object') continue;
    const { type, offset, length } = e as Record<string, unknown>;
    if (!ENTITY_TYPES.includes(type as EntityType) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) continue;
    const s = Math.max(0, offset as number), end = Math.min(text.length, (offset as number) + (length as number));
    if (end <= s) continue;
    const url = type === 'link' ? entityUrl((e as { url?: unknown }).url) : undefined;
    if (type === 'link' && !url) continue;
    const date = type === 'date' ? (e as { date?: unknown }).date : undefined;
    const format = type === 'date' ? ((e as { format?: unknown }).format ?? '') : undefined;
    // дата: целые секунды с 1970 до 2100 года и формат из допустимых букв
    if (type === 'date' && (!Number.isSafeInteger(date) || (date as number) < 0 || (date as number) > 4102444800 || typeof format !== 'string' || !DATE_FORMAT.test(format))) continue;
    const key = type === 'link' ? 'link ' + url : type === 'date' ? 'date ' + date + ' ' + format : (type as string);
    const list = by.get(key) ?? [];
    list.push(url ? { type: 'link', offset: s, length: end - s, url } : type === 'date' ? { type: 'date', offset: s, length: end - s, date: date as number, ...(format ? { format: format as string } : {}) } : { type: type as EntityType, offset: s, length: end - s });
    by.set(key, list);
  }
  const out: Entity[] = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.offset - b.offset);
    let cur: Entity | null = null;
    for (const e of list) {
      if (cur && e.offset <= cur.offset + cur.length) cur.length = Math.max(cur.length, e.offset + e.length - cur.offset);
      else { cur = { ...e }; out.push(cur); }
    }
  }
  return out.sort((a, b) => a.offset - b.offset || b.length - a.length).slice(0, MAX_ENTITIES);
}

/** Обрезать пробелы по краям текста и сдвинуть оформление вместе с ним. */
export function trimFormatted(body: string, entities: Entity[]): { text: string; entities: Entity[] } {
  const lead = body.length - body.trimStart().length;
  const text = body.trim();
  return { text, entities: normalizeEntities(text, entities.map((e) => ({ ...e, offset: e.offset - lead }))) };
}

/** Вложение: фото (знает размеры заранее — лента не прыгает) или файл. thumb — крошечное размытое превью. */
export interface Attachment {
  id: string; kind: AttachmentKind; mime: string; name: string; size: number; w: number | null; h: number | null; thumb?: string | null;
  duration?: number | null;   // голосовое, кружок, видео и музыка: целые секунды
  waveform?: string | null;   // голосовое: 63 байта (100 значений по 5 бит, младшие биты первыми) в base64
  title?: string | null;      // музыка: из тегов файла
  performer?: string | null;
  spoiler?: boolean;          // фото и видео «под спойлером»: размыто, пока не нажмут (как в Telegram)
  /** Видео после обработки на сервере (до неё — нет): короткий немой ролик для ленты и облегчённые копии для просмотра.
   *  Адрес — /files/<id>/<name>; оригинал остаётся /files/<id>. */
  preview?: VideoVariant | null;
  variants?: VideoVariant[];
  /** Зашифровано на клиенте (fileCrypto.ts): в хранилище шифр, key — ключ файла (base64; в сообщении он запечатан ключом чата). */
  enc?: 1;
  key?: string;
}
/** Копия видео: preview — первые секунды без звука, 360p, до 1 МБ (лента); '720' — H.264 720p (просмотрщик по умолчанию).
 *  У фото и картинки-файла preview — WebP, длинная сторона до 480 px (сетка «Медиа»); medium — WebP до 800 px (пузырь в ленте). */
export interface VideoVariant { name: 'preview' | '720' | 'medium'; w: number; h: number; size: number }
/** video — видео как медиа (кадр, длительность, играет в ленте); видео «как файл» остаётся file с mime video/*. */
export type AttachmentKind = 'photo' | 'video' | 'file' | 'voice' | 'round' | 'audio';
/** Вкладки «Общих медиа» (как в Telegram): медиа — фото и видео, файлы, музыка, голосовые и кружки, ссылки. */
export type MediaTab = 'media' | 'file' | 'audio' | 'voice' | 'link';
export const MEDIA_TABS: readonly MediaTab[] = ['media', 'file', 'link', 'audio', 'voice'];
/** Счётчики вкладок; video — сколько из «Медиа» видео (шапка пишет «N фото, M видео»), у старого сервера его нет. */
export type MediaCounts = Record<MediaTab, number> & { video?: number };
/** Видео среди «Медиа» — зеркало SQL в getChatMediaCounts. */
export const isVideoMedia = (m: Pick<Message, 'kind' | 'attachment'>): boolean =>
  m.kind === 'video' || (m.kind === 'file' && (m.attachment?.mime?.startsWith('video/') ?? false));

type TabFields = Pick<Message, 'kind' | 'attachment' | 'body' | 'entities'> & Partial<Pick<Message, 'service'>>;
/**
 * Во всех вкладках «Общих медиа», где лежит сообщение, — зеркало SQL `tabWhere` на сервере (apps/server/src/domain/chats.ts).
 * Вкладки пересекаются: ссылка в подписи фото или файла — и медиа/файл, и ссылка (сервер так же считает счётчики).
 * Служебные сообщения (service) в «ссылках» не участвуют.
 */
export function mediaTabs(m: TabFields): MediaTab[] {
  const video = m.attachment?.mime?.startsWith('video/') ?? false;
  const tabs: MediaTab[] = [];
  if (m.kind === 'photo' || m.kind === 'video' || (m.kind === 'file' && video)) tabs.push('media');
  if (m.kind === 'file' && !video) tabs.push('file');
  if (m.kind === 'audio') tabs.push('audio');
  if (m.kind === 'voice' || m.kind === 'round') tabs.push('voice');
  if (!m.service && (/(https?:\/\/|www\.)\S/i.test(m.body) || (m.entities?.some((e) => e.type === 'link') ?? false))) tabs.push('link');
  return tabs;
}
/** Основная вкладка сообщения (по файлу, если он есть; иначе «ссылки»); null — в общих медиа не попадает. Полный состав — mediaTabs. */
export function mediaTab(m: TabFields): MediaTab | null {
  return mediaTabs(m)[0] ?? null;
}
/** Кружок: сторона квадрата и предел длительности (как в Telegram). */
export const ROUND_SIZE = 400;
export const ROUND_MAX_SECONDS = 60;
export const WAVEFORM_BYTES = 63;
/** Предел одного файла — как у Telegram без Premium: 2 ГБ. Сервер отказывает (file_too_big), клиент проверяет до очереди. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Реакция: кто и какой эмодзи (одна от пользователя на сообщение). */
export interface Reaction { userId: Id; emoji: string }
/** Реакция из каталога сервера (GET /reactions): ключ — emojiKey, адреса — неизменяемые файлы /rx/<slug>/<хэш>/<файл>. */
/** Каталог анимированных эмодзи: emoji — анимация одиночного эмодзи, effects — варианты эффекта по клику, generic — общие (💥),
 *  dice — грани броска по эмодзи (DiceEmoji): [0] — «летит», пока значения нет, [n] — исход n (без 🎰: у слотов слои). */
export interface AnimatedEmojiCatalog { hash: string; emoji: Record<string, string>; effects: Record<string, string[]>; generic: string[]; dice?: Record<string, DiceFace[]> }
export interface DiceFace { url: string; outline: string | null }

/** Группа эмодзи (как в Telegram): чип в поиске панели — иконка (белая анимация .tgs, подкрашивается темой) и эмодзи группы. */
export interface EmojiGroup { title: string; icon: string; emoticons: string[] }
/** Каталог групп (GET /emoji-groups): emoji — для панели эмодзи, sticker — для стикеров (там ещё «Привет»). */
export interface EmojiGroupsCatalog { hash: string; emoji: EmojiGroup[]; sticker: EmojiGroup[] }

export interface ReactionAsset {
  key: string;
  title: string;         // «Red Heart»
  inactive: boolean;     // в Telegram снята с выбора — рисуем, но не предлагаем
  static: string;        // .webp
  appear: string; select: string;   // .tgs
  center: string | null; around: string | null;   // эффект над сообщением (.tgs), не у всех
  silhouette?: string | null;   // маска-силуэт (data: PNG) — на месте значка, пока он грузится (tools/reactions/silhouettes.py)
}

export type Update =
  | { type: 'newMessage'; message: Message }
  | { type: 'readOwn'; chatId: Id; upToId: Id }
  | { type: 'readBy'; chatId: Id; userId: Id; upToId: Id }
  | { type: 'draft'; chatId: Id; text: string; at: string; entities?: Entity[] }   // черновик своих устройств; пустой текст — удалён
  | { type: 'messageEdited'; chatId: Id; id: Id; body: string; editedAt: string; entities?: Entity[] }
  | { type: 'todoUpdated'; chatId: Id; id: Id; todo: Todo; editedAt?: string }
  | { type: 'pollUpdated'; chatId: Id; id: Id; voters: number; counts: number[]; closed: boolean; correct?: number; solution?: string }   // общие итоги опроса (ответ викторины — только у закрытого)
  | { type: 'pollVoted'; chatId: Id; id: Id; my: number[]; correct?: number; solution?: string }   // свои голоса (свой журнал): после голоса викторина раскрывает ответ   // чек-лист целиком: отметили, добавили или изменили
  // ответ на нажатие кнопки: новый текст и кнопки (null — кнопок больше нет); «изм.» не ставится — как правка бота
  | { type: 'messageMarkup'; chatId: Id; id: Id; body: string; entities?: Entity[]; buttons: MessageButton[][] | null }
  | { type: 'messageDeleted'; chatId: Id; id: Id }
  | { type: 'reactions'; chatId: Id; id: Id; reactions: Reaction[] }
  // пост канала: реакции счётчиками (не чаще раза в секунду на пост — reactions.flush); своя реакция — ответом на react
  | { type: 'reactionCounts'; chatId: Id; id: Id; counts: [string, number][] }
  // комментарии к посту (журнал канала, не чаще раза в секунду на пост — replies.flush); readMaxId не несёт
  | { type: 'replies'; chatId: Id; id: Id; count: number; lastId: Id | null; recent: Id[] }
  // тред прочитан до upToId (chatId — группа обсуждения, threadId — копия поста): только своим устройствам
  | { type: 'readThread'; chatId: Id; threadId: Id; upToId: Id }
  // меня упомянули (@имя или ответ): только мне; сообщение целиком (журнал хранит ссылку), threadId — упоминание в треде
  | { type: 'mention'; message: Message; threadId?: Id }
  // чужая реакция на моё сообщение (только мне): кнопка «сердце» над «вниз»; reactionsRead — снято (увидел на экране,
  // «прочитать все», реакцию убрали или сообщение удалили); без ids — все в чате
  | { type: 'reaction'; chatId: Id; id: Id }
  | { type: 'reactionsRead'; chatId: Id; ids?: Id[] }
  | { type: 'mediaListened'; chatId: Id; id: Id }   // голосовое/кружок прослушали
  | { type: 'userUpdated'; user: PublicUser }   // профиль изменился: себе и всем, кто видит пользователя
  // контакт добавлен/изменён (contact) или удалён (removed + user — как его видно без контакта); только владельцу
  | { type: 'contactsChanged'; contact?: Contact; removed?: Id; user?: PublicUser | null }
  // настройки аккаунта (общие для устройств) изменились: приходят целиком, только владельцу
  | { type: 'settingsChanged'; settings: UserSettings }
  // правила конфиденциальности изменились: приходят целиком, только владельцу
  | { type: 'privacyChanged'; rules: PrivacyRules }
  // чёрный список: человек заблокирован (blocked) или разблокирован (unblocked); только владельцу
  | { type: 'blocksChanged'; blocked?: BlockedUser; unblocked?: Id }
  | { type: 'sessionsChanged' }
  | { type: 'pins'; chatId: Id; ids: Id[] }
  | { type: 'linkPreview'; chatId: Id; id: Id; link: LinkPreview | null }
  | { type: 'attachmentUpdated'; chatId: Id; id: Id; attachment: Attachment }   // видео обработано: копии и faststart-оригинал
  // группа: информация и настройки целиком — всем участникам
  | { type: 'groupUpdated'; chatId: Id; group: GroupInfo }
  // моё место в группе (роль, права, исключение, звание) — только мне
  // seq — у вступления: номер журнала чата на момент коммита (клиент заводит чат и ничего не догоняет); при смене прав нет
  | { type: 'membership'; chatId: Id; me: MyMembership; seq?: number }
  // заявок на вступление — только тем, кто их принимает (groupUpdated этого поля больше не несёт: оно у каждого своё)
  | { type: 'joinRequests'; chatId: Id; requests: number }
  // состав изменился: у кого строка новая или другая (upsert), кто вышел или удалён (remove)
  | { type: 'members'; chatId: Id; upsert: MemberRow[]; remove: Id[] }
  // чат больше не мой: вышел, удалили, группу удалили
  | { type: 'chatFlags'; chatId: Id; pinnedAt: number | null; archived: boolean; unreadMark: boolean; archivedAtId?: number }   // закреплён (мс; позже — выше), в архиве, «непрочитанное»
  | { type: 'chatNotify'; chatId: Id; muteUntil: number | null }   // уведомления чата: мс эпохи — выключены до, 0 — навсегда, null — включены
  | { type: 'chatRemoved'; chatId: Id }
  | { type: 'myStickers' };   // мои паки / недавние / избранные изменились — перечитать GET /my-stickers   // превью ссылки сообщения загрузилось (null — превью нет)   // закреплённые сообщения чата целиком (новые сверху)   // список сеансов изменился: новый вход, подтверждение, завершение

/** Строка участника группы в журнале (имя и присутствие — из профиля и присутствия). */
export interface MemberRow { userId: Id; role: 'owner' | 'admin' | 'member'; rank: string | null }

/** Тело уведомления/push без предпросмотра: текст сообщения не раскрываем. */
export const NO_PREVIEW = 'Новое сообщение';

/** Вид чата для умолчаний уведомлений. */
export type NotifyType = 'direct' | 'group' | 'channel';
export interface NotifyPref { muted: boolean; preview: boolean }
/** Настройки аккаунта (GET /settings добавляет seq своей записи журнала на момент снимка). */
export interface UserSettings { notify: Record<NotifyType, NotifyPref>; sessionsTtlDays: number; folders: ChatFolder[] }   // folders — свои папки по порядку вкладок
export interface SettingsSnapshot extends UserSettings { privacy?: PrivacyRules; seq?: number }
/** Сроки автозавершения неактивных сеансов, дней (PUT /settings/sessions-ttl). */
export const SESSION_TTLS: readonly number[] = [7, 30, 90, 180, 365];

/** Сеанс (GET /sessions): устройство — грубо по User-Agent («Chrome 141, macOS»), IP входа; current — этот запрос. */
/** limited — новый сеанс (не подтверждён или первые сутки): не завершает другие, не меняет пароль и паскеи.
 *  place — «Москва, Россия» по IP; method — как вошли. */
export interface SessionInfo { id: Id; device: string; ip: string | null; createdAt: string; lastActiveAt: string; current: boolean; online: boolean; unconfirmed: boolean;
  limited?: boolean; place?: string | null; method?: 'code' | 'password' | 'recovery' | 'signup' | 'passkey' | 'qr' | 'dev' | null }

/** Правила конфиденциальности. phoneDiscovery — «Кто найдёт меня по номеру» (только everyone | contacts). */
export type PrivacyKey = 'phone' | 'phoneDiscovery' | 'lastSeen' | 'bio' | 'birthday';
export type PrivacyMode = 'everyone' | 'contacts' | 'nobody';
export const PRIVACY_KEYS: readonly PrivacyKey[] = ['phone', 'phoneDiscovery', 'lastSeen', 'bio', 'birthday'];
/** Исключения: deny главнее allow, allow главнее mode. */
export interface PrivacyRule { mode: PrivacyMode; allow: Id[]; deny: Id[] }
export type PrivacyRules = Record<PrivacyKey, PrivacyRule>;
/** Умолчания, когда правила нет: номер — контактам, остальное — всем. */
export const defaultPrivacyRule = (key: PrivacyKey): PrivacyRule => ({ mode: key === 'phone' ? 'contacts' : 'everyone', allow: [], deny: [] });
export const defaultPrivacy = (): PrivacyRules => ({
  phone: defaultPrivacyRule('phone'), phoneDiscovery: defaultPrivacyRule('phoneDiscovery'), lastSeen: defaultPrivacyRule('lastSeen'),
  bio: defaultPrivacyRule('bio'), birthday: defaultPrivacyRule('birthday'),
});

/** Заблокированный: профиль глазами владельца списка и когда заблокирован. seq — как у Contact. */
export interface BlockedUser { userId: Id; user: PublicUser; at: string; seq?: number }

/** День рождения: год необязателен. */
export interface Birthday { day: number; month: number; year?: number }

/** Профиль глазами зрителя (скрытые правилами приватности поля сервер не отдаёт). */
/** Фото профиля: id — 640×640, small — 160×160 (оба — файлы /files/:id), thumb — крошечное размытое превью (data:URL), at — когда поставлено (мс). */
export interface ProfilePhoto { id: string; small: string; thumb: string; at: number; pid?: number; video?: string }
/** Фото из истории профиля (GET /users/:id/photos): pid — номер в истории; video — видео-аватарка (зацикленная, без звука). */
export interface UserPhoto { pid: number; id: string; small: string; thumb: string; video?: string; at: number }

export interface PublicUser {
  /** системный пользователь «Relay»: служебные уведомления, ответить нельзя */
  system?: true;
  id: Id; name: string; firstName: string; lastName: string;
  username: string | null; bio: string | null; birthday: Birthday | null; phone: string | null;
  links: ProfileLink[];   // ссылки на профили в других сервисах, в порядке владельца; видны всем
  /** фото профиля; null — нет или зритель заблокирован */
  photo?: ProfilePhoto | null;
  /** собственное имя пользователя; name/firstName/lastName у владельца контакта — контактные */
  publicName?: string;
  /** этот человек заблокировал зрителя: писать ему в личный чат нельзя (плашка вместо поля ввода) */
  blocksMe?: boolean;
  /** музыка профиля: сколько треков и последний добавленный (плашка под аватаром); список — GET /users/:id/music */
  music?: ProfileMusicSummary | null;
  /** личный канал: публичный канал владельца в профиле — снимок для строки; последний пост — GET /groups/:id */
  personalChannel?: PersonalChannel | null;
}

/** Канал в профиле (и кандидат в него, GET /me/personal-channels): members — число подписчиков. */
export interface PersonalChannel { id: Id; title: string; username: string; photo: ProfilePhoto | null; members: number }

export interface ProfileMusicSummary { count: number; top: { id: string; title: string; duration: number | null } }

/** Контакт: имя, которое дал владелец (видно только ему), заметка, профиль и присутствие.
 *  seq — номер записи журнала владельца, на момент которой снят ответ (порядок ответов и журнала). */
export interface Contact {
  userId: Id; firstName: string; lastName: string; note: string;
  user: PublicUser;
  presence?: { online: boolean | null; lastSeen: string | null };
  seq?: number;
}

/** Собственный профиль (GET /me). userId и name — совместимость со старым клиентом.
 *  seq — номер записи своего журнала, на момент которой снят профиль: клиент не даёт старой записи userUpdated
 *  откатить более свежий ответ. */
export interface Me {
  userId: Id; name: string; firstName: string; lastName: string;
  username: string | null; bio: string | null; birthday: Birthday | null; phone: string | null;
  links: ProfileLink[];
  photo?: ProfilePhoto | null;
  music?: ProfileMusicSummary | null;
  personalChannel?: PersonalChannel | null;
  seq?: number;
}

export interface JournalEntry { seq: number; update: Update }

export type ErrorCode = 'bad_frame' | 'pin_limit' | 'unauthorized' | 'not_member' | 'not_found' | 'too_long' | 'forbidden' | 'internal'
  | 'username_invalid' | 'username_taken' | 'username_reserved' | 'bio_too_long' | 'name_invalid' | 'birthday_invalid' | 'links_invalid' | 'note_too_long'
  | 'blocked' | 'code_invalid' | 'code_expired' | 'flood' | 'fresh_session' | 'device_invalid'
  | 'password_invalid' | 'password_missing' | 'recovery_unavailable' | 'email_invalid' | 'qr_expired' | 'passkey_not_found' | 'passkey_invalid'
  | 'folder_title' | 'folder_empty' | 'folder_too_many_chats' | 'folder_emoji' | 'folders_limit'
  | 'upload_limit' | 'upload_quota'   // пределы загрузок на пользователя (apps/server/src/domain/uploadLimits.ts)
  | 'upload_missing' | 'upload_mismatch' | 'upload_pending' | 'upload_incomplete' | 'photo_invalid' | 'file_too_big';

export type ClientFrame =
  | { op: 'prove'; sig: string }   // ответ на challenge: подпись «relay-device|ws|<nonce>» ключом устройства
  | { op: 'hello'; lastSeq: number; since?: number }   // since — мс по часам сервера из прошлого hello/chats: какие группы менялись с тех пор
  | { op: 'sync'; since: number }
  | { op: 'syncChat'; reqId: string; chatId: Id; since: number }   // догнать журнал одного чата (группы, каналы)
  | { op: 'chatsSince'; since: number }                             // сверка: какие группы менялись после since
  // превью публичного канала: push'и канала в этот сокет без подписки, пока превью открыто; ack.result — {seq}
  | { op: 'watchChat'; reqId: string; chatId: Id }
  | { op: 'unwatchChat'; chatId: Id }
  | { op: 'send'; reqId: string; clientId: string; chatId: Id; body: string; entities?: Entity[]; replyToId?: Id | null; attachment?: { id: string; thumb?: string | null; spoiler?: boolean } | null; groupId?: string | null; forward?: ForwardRef | null; noLinkPreview?: boolean; blocks?: Block[] | null; todo?: TodoInput; poll?: PollInput; contact?: { userId: Id }; geo?: GeoPoint; dice?: { emoji: DiceEmoji }; sticker?: { id: Id } | null; threadId?: Id; draftHash?: string | null }   // threadId — комментарий в треде (группа обсуждения)
  | { op: 'read'; reqId: string; chatId: Id; upToId: Id }
  | { op: 'typing'; chatId: Id }   // «печатаю» — без ответа, сервер пересылает остальным участникам
  // клики по большому эмодзи (только личный чат): t — секунды от первого клика пачки; сервер пересылает собеседнику, в журнал не пишет
  | { op: 'emojiFx'; chatId: Id; id: Id; key: string; t: number[] }
  | { op: 'draft'; reqId: string; chatId: Id; text: string; entities?: Entity[] }
  | { op: 'edit'; reqId: string; chatId: Id; id: Id; body: string; entities?: Entity[] }
  | { op: 'delete'; reqId: string; chatId: Id; id: Id }
  | { op: 'react'; reqId: string; chatId: Id; id: Id; emoji: string | null }
  | { op: 'todoToggle'; reqId: string; chatId: Id; id: Id; completed: number[]; incompleted: number[] }
  | { op: 'pollVote'; reqId: string; chatId: Id; id: Id; options: number[] }   // пусто — отозвать голос
  | { op: 'pollClose'; reqId: string; chatId: Id; id: Id }
  | { op: 'todoAppend'; reqId: string; chatId: Id; id: Id; items: string[] }
  | { op: 'todoEdit'; reqId: string; chatId: Id; id: Id; todo: TodoInput }
  | { op: 'listened'; reqId: string; chatId: Id; id: Id }
  // открыт тред группы обсуждения, где я не участник: живые события треда кадрами threadPush, пока не unwatchThread
  | { op: 'watchThread'; reqId: string; chatId: Id; threadId: Id }
  | { op: 'unwatchThread'; reqId: string; chatId: Id; threadId: Id }
  // нажата callback-кнопка; ack.result — ButtonAnswer
  | { op: 'button'; reqId: string; chatId: Id; id: Id; data: string }
  | { op: 'ping' };

/** Ответ на нажатие кнопки: короткий тост (нет — молча). */
export interface ButtonAnswer { toast?: string }

/** Присутствие собеседника: в сети сейчас или когда был последний раз (ISO).
 *  Скрыто правилом «Последний визит» — {online: null, lastSeen: 'recently'} («был(а) недавно»). */
export const RECENTLY = 'recently';
export interface PresenceItem { userId: number; online: boolean | null; lastSeen: string | null }

export type ServerFrame =
  | { op: 'challenge'; nonce: string }   // сеанс привязан к устройству: подпиши вызов (prove), иначе кадры не выполняются
  | { op: 'hello'; seq: number; epoch: string; now: number; chats: [chatId: Id, seq: number][] }   // epoch — поколение базы; chats — группы, менявшиеся после since; now — следующий since
  | { op: 'chats'; now: number; items: [chatId: Id, seq: number][] }
  | { op: 'chatUpdates'; reqId: string; chatId: Id; from: number; to: number; items: JournalEntry[]; more: boolean }
  | { op: 'chatTooLong'; reqId: string; chatId: Id; seq: number }   // журнал чата подрезан дальше since: перезагрузить этот чат
  | { op: 'chatGone'; reqId: string; chatId: Id }                   // не участник (исключён) или чата нет
  | { op: 'updates'; from: number; to: number; items: JournalEntry[]; more: boolean }
  // событие журнала сразу, без sync: клиент применяет, если from — его номер (личный или чата chatId), иначе
  // синхронизируется (sync / syncChat). Пустые items — «догони чат» (события не поместились в уведомление)
  // gone — чат удалён (журнал чата закрыт): убрать его у себя без syncChat
  | { op: 'push'; chatId?: Id; from: number; to: number; items: JournalEntry[]; gone?: true }
  | { op: 'tooLong'; seq: number }
  // события треда для того, кто смотрит его не участником (watchThread): без номеров журнала — живой вид, не журнал.
  // Пустые items — «перечитай край треда» (события не поместились в уведомление)
  | { op: 'threadPush'; chatId: Id; threadId: Id; items: Update[] }
  | { op: 'ack'; reqId: string; result: Record<string, unknown> }
  | { op: 'err'; reqId?: string; code: ErrorCode; retry: boolean }
  | { op: 'poke' }
  | { op: 'presence'; items: PresenceItem[] }
  | { op: 'typing'; chatId: Id; userId: Id }
  | { op: 'emojiFx'; chatId: Id; id: Id; key: string; t: number[]; userId: Id }
  // сеанс этого сокета завершён; следом сокет закрывается. reason: logout — выход в другой вкладке этого же браузера,
  // terminated — с другого устройства, автозавершением или сеанс пропал
  | { op: 'sessionTerminated'; reason?: 'logout' | 'terminated' }
  | { op: 'pong' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_HASH = /^[0-9a-f]{64}$/;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function parseClientFrame(raw: string): ClientFrame | null {
  let f: Record<string, unknown>;
  try { f = JSON.parse(raw); } catch { return null; }
  if (!f || typeof f !== 'object') return null;
  switch (f.op) {
    case 'hello': return int(f.lastSeq) ? { op: 'hello', lastSeq: f.lastSeq, ...(int(f.since) ? { since: f.since } : {}) } : null;
    case 'sync': return int(f.since) ? { op: 'sync', since: f.since } : null;
    case 'syncChat': return str(f.reqId, 64) && int(f.chatId) && int(f.since) ? { op: 'syncChat', reqId: f.reqId, chatId: f.chatId, since: f.since } : null;
    case 'chatsSince': return int(f.since) ? { op: 'chatsSince', since: f.since } : null;
    case 'watchChat': return str(f.reqId, 64) && int(f.chatId) ? { op: 'watchChat', reqId: f.reqId, chatId: f.chatId } : null;
    case 'unwatchChat': return int(f.chatId) ? { op: 'unwatchChat', chatId: f.chatId } : null;
    case 'ping': return { op: 'ping' };
    case 'typing': return int(f.chatId) ? { op: 'typing', chatId: f.chatId } : null;
    case 'emojiFx': return int(f.chatId) && int(f.id) && str(f.key, 16) && Array.isArray(f.t) && f.t.length > 0 && f.t.length <= EMOJI_FX_MAX && f.t.every((x) => typeof x === 'number' && x >= 0 && x <= EMOJI_FX_WINDOW_S)
      ? { op: 'emojiFx', chatId: f.chatId, id: f.id, key: f.key, t: (f.t as number[]).map((x) => Math.round(x * 100) / 100) } : null;
    case 'edit': return str(f.reqId, 64) && int(f.chatId) && int(f.id) && typeof f.body === 'string' ? { op: 'edit', reqId: f.reqId, chatId: f.chatId, id: f.id, body: f.body, entities: normalizeEntities(f.body, f.entities) } : null;
    case 'delete': return str(f.reqId, 64) && int(f.chatId) && int(f.id) ? { op: 'delete', reqId: f.reqId, chatId: f.chatId, id: f.id } : null;
    case 'button': return str(f.reqId, 64) && int(f.chatId) && int(f.id) && str(f.data, BUTTON_DATA_MAX) ? { op: 'button', reqId: f.reqId, chatId: f.chatId, id: f.id, data: f.data } : null;
    case 'listened': return str(f.reqId, 64) && int(f.chatId) && int(f.id) ? { op: 'listened', reqId: f.reqId, chatId: f.chatId, id: f.id } : null;
    case 'watchThread': case 'unwatchThread':
      return str(f.reqId, 64) && int(f.chatId) && int(f.threadId) ? { op: f.op, reqId: f.reqId, chatId: f.chatId, threadId: f.threadId } : null;
    case 'todoToggle': {
      const ids = (v: unknown) => Array.isArray(v) && v.length <= TODO_ITEMS_MAX && v.every((x) => int(x)) ? v as number[] : null;
      const done = ids(f.completed), undone = ids(f.incompleted);
      return str(f.reqId, 64) && int(f.chatId) && int(f.id) && done && undone ? { op: 'todoToggle', reqId: f.reqId, chatId: f.chatId, id: f.id, completed: done, incompleted: undone } : null;
    }
    case 'pollVote': return str(f.reqId, 64) && int(f.chatId) && int(f.id) && Array.isArray(f.options) && f.options.length <= POLL_OPTIONS_MAX && f.options.every((x) => Number.isSafeInteger(x) && (x as number) > 0)
      ? { op: 'pollVote', reqId: f.reqId, chatId: f.chatId, id: f.id, options: [...new Set(f.options as number[])] } : null;
    case 'pollClose': return str(f.reqId, 64) && int(f.chatId) && int(f.id) ? { op: 'pollClose', reqId: f.reqId, chatId: f.chatId, id: f.id } : null;
    case 'todoAppend': return str(f.reqId, 64) && int(f.chatId) && int(f.id) && Array.isArray(f.items) && f.items.length >= 1 && f.items.length <= TODO_ITEMS_MAX && f.items.every((x) => typeof x === 'string')
      ? { op: 'todoAppend', reqId: f.reqId, chatId: f.chatId, id: f.id, items: f.items as string[] } : null;
    case 'todoEdit': { const t = normalizeTodo(f.todo); return str(f.reqId, 64) && int(f.chatId) && int(f.id) && t ? { op: 'todoEdit', reqId: f.reqId, chatId: f.chatId, id: f.id, todo: t } : null; }
    case 'react': return str(f.reqId, 64) && int(f.chatId) && int(f.id) && (f.emoji === null || str(f.emoji, 16)) ? { op: 'react', reqId: f.reqId, chatId: f.chatId, id: f.id, emoji: f.emoji as string | null } : null;
    case 'draft': return str(f.reqId, 64) && int(f.chatId) && typeof f.text === 'string' ? { op: 'draft', reqId: f.reqId, chatId: f.chatId, text: f.text, entities: normalizeEntities(f.text, f.entities) } : null;
    case 'send':
      if (!str(f.reqId, 64) || !str(f.clientId, 36) || !UUID.test(f.clientId) || !int(f.chatId) || typeof f.body !== 'string') return null;
      if (f.replyToId != null && !int(f.replyToId)) return null;
      if (f.attachment != null && (typeof f.attachment !== 'object' || !str((f.attachment as { id: unknown }).id, 36))) return null;
      if (f.groupId != null && !(typeof f.groupId === 'string' && UUID.test(f.groupId))) return null;
      let forward: ForwardRef | null = null;
      if (f.forward != null) {
        const w = f.forward as Record<string, unknown>;
        if (typeof w !== 'object' || !int(w.chatId) || !int(w.id)) return null;
        forward = { chatId: w.chatId as number, id: w.id as number, hideSender: w.hideSender === true, hideCaption: w.hideCaption === true };
      }
      if (f.todo != null && !normalizeTodo(f.todo)) return null;
      if (f.poll != null && !normalizePoll(f.poll)) return null;
      if (f.geo != null && !normalizeGeo(f.geo)) return null;
      if (f.dice != null && !isDiceEmoji((f.dice as { emoji?: unknown }).emoji)) return null;
      if (f.contact != null && !int((f.contact as { userId?: unknown }).userId)) return null;
      if (f.sticker != null && (typeof f.sticker !== 'object' || !int((f.sticker as { id: unknown }).id))) return null;
      if (f.threadId != null && !int(f.threadId)) return null;
      if (f.draftHash != null && !(typeof f.draftHash === 'string' && DRAFT_HASH.test(f.draftHash))) return null;
      return { op: 'send', ...(f.draftHash !== undefined ? { draftHash: f.draftHash as string | null } : {}), ...(f.threadId != null ? { threadId: f.threadId as number } : {}), ...(f.sticker != null ? { sticker: { id: (f.sticker as { id: number }).id } } : {}), ...(f.todo != null ? { todo: normalizeTodo(f.todo)! } : {}), ...(f.poll != null ? { poll: normalizePoll(f.poll)! } : {}), ...(f.geo != null ? { geo: normalizeGeo(f.geo)! } : {}), ...(f.dice != null ? { dice: { emoji: (f.dice as { emoji: DiceEmoji }).emoji } } : {}), ...(f.contact != null ? { contact: { userId: (f.contact as { userId: number }).userId } } : {}), reqId: f.reqId, clientId: f.clientId, chatId: f.chatId, body: f.body, entities: normalizeEntities(f.body, f.entities), replyToId: (f.replyToId as number | null) ?? null, attachment: (f.attachment as { id: string; thumb?: string | null; spoiler?: boolean } | null) ?? null, groupId: (f.groupId as string | null) ?? null, forward, ...(f.noLinkPreview === true ? { noLinkPreview: true } : {}), ...(Array.isArray(f.blocks) ? { blocks: f.blocks as Block[] } : {}) };
    case 'read':
      return str(f.reqId, 64) && int(f.chatId) && int(f.upToId) ? { op: 'read', reqId: f.reqId, chatId: f.chatId, upToId: f.upToId } : null;
    default: return null;
  }
}

/** Знаки-заглушки вместо скрытого текста (Брайль: похоже на «шум», ширина близка к буквам). */
export const SPOILER_FILL = '⠺⠵⠞⠟⠽⠾⠷⠯';

/**
 * Текст, где спойлеры заменены заглушкой (пробелы и переводы строк сохраняются): для уведомлений,
 * push и превью — туда, где спойлер не раскрыть, настоящий текст не попадает.
 */
export function hideSpoilers(text: string, entities?: readonly { type: string; offset: number; length: number }[] | null): string {
  if (!entities?.length) return text;
  let out: string[] | null = null;
  for (const e of entities) {
    if (e.type !== 'spoiler') continue;
    out ??= text.split('');   // смещения — в единицах UTF-16, как и у сущностей
    for (let i = e.offset; i < Math.min(text.length, e.offset + e.length); i++) if (!/\s/.test(text[i])) out[i] = SPOILER_FILL[i % SPOILER_FILL.length];
  }
  return out ? out.join('') : text;
}

/* ---------- чек-листы (как в Telegram: todoList) ---------- */

/** Задача: id — номер внутри списка (1..N при создании, новые — максимум + 1). */
export interface TodoItem { id: number; title: string }
/** Отметка «выполнено»: какая задача, кто и когда. */
export interface TodoCompletion { id: number; by: Id; at: string }
export interface Todo { title: string; items: TodoItem[]; othersCanAppend: boolean; othersCanComplete: boolean; completions: TodoCompletion[] }
/** Что присылает клиент при создании и правке: задачи без номера получают их на сервере. */
export interface TodoInput { title: string; items: { id?: number; title: string }[]; othersCanAppend: boolean; othersCanComplete: boolean }
/** Данные служебной строки чек-листа: какие задачи отметили / сняли / добавили. */
export type TodoServiceData = ServiceData;

/** Пределы как у Telegram (todo_items_max / todo_title_length_max / todo_item_length_max по умолчанию). */
export const TODO_ITEMS_MAX = 30;
export const TODO_TITLE_MAX = 32;
export const TODO_ITEM_MAX = 64;
const glyphs = (s: string) => [...s].length;

/** Проверка чек-листа от клиента: заголовок и задачи непустые и в пределах; переводы строк — пробелы. null — не чек-лист. */
export function normalizeTodo(raw: unknown): TodoInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const line = (v: unknown) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  const title = line(r.title);
  if (!title || glyphs(title) > TODO_TITLE_MAX || !Array.isArray(r.items)) return null;
  const items: { id?: number; title: string }[] = [];
  const seen = new Set<number>();
  for (const it of r.items) {
    const t = line(it && typeof it === 'object' ? (it as Record<string, unknown>).title : it);
    if (!t) continue;
    if (glyphs(t) > TODO_ITEM_MAX) return null;
    const id = it && typeof it === 'object' ? (it as Record<string, unknown>).id : undefined;
    if (Number.isSafeInteger(id) && (id as number) > 0 && !seen.has(id as number)) { seen.add(id as number); items.push({ id: id as number, title: t }); }
    else items.push({ title: t });
  }
  if (!items.length || items.length > TODO_ITEMS_MAX) return null;
  return { title, items, othersCanAppend: r.othersCanAppend === true, othersCanComplete: r.othersCanComplete === true };
}

/** Слова сообщения для офлайн-поиска: нижний регистр, ё → е, буквы и цифры, длина 2–32, без повторов, не больше 64. */
export function searchTerms(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.normalize('NFC').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 2 || w.length > 32) continue;
    out.add(w);
    if (out.size >= 64) break;
  }
  return [...out];
}

export * from './groups';
export * from './polls';
export * from './special';
import { isDiceEmoji, normalizeGeo, type ContactCard, type Dice, type DiceEmoji, type GeoPoint } from './special';
import { normalizePoll, POLL_OPTIONS_MAX, type Poll, type PollInput } from './polls';
export * from './blocks';
export * from './fileCrypto';
export * from './mentions';

/** Можно ли править текст сообщения этого вида (как в Telegram): у стикера, кружка, голосового и опроса текста нет,
 *  чек-лист правится своей операцией. Общее правило для меню клиента и проверки сервера. */
export const canEditKind = (kind: string): boolean => !['sticker', 'round', 'voice', 'poll', 'todo', 'contact', 'geo', 'dice'].includes(kind);
