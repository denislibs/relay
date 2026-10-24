import { hasMedia, rightForKind, type GroupInfo, type MemberRight, type MyMembership } from '@relay/protocol';
import { MEMBER_RIGHT_TEXT } from '../groups';
import { PinnedBar } from './PinnedBar';
import { UploadBar } from './UploadBar';
import { videoCompressSupported, type VideoQuality } from '../media/compressVideo';
import { entriesOf, filesFromEntries } from '../media/dropFiles';
import { quoteContent } from './preview';
import { ChatMenu } from './ChatMenu';
import { senderAvatar } from '../profilePhoto';
import { firstUrl, loadPreview } from '../linkUrl';
import { MusicPicker } from './MusicPicker';
import { ArticleComposer, preloadArticleEditor } from './ArticleComposer';
import { blocksText, blocksToText, textToBlocks, type Block, type Replies } from '@relay/protocol';
import { ChannelBar, GuestJoinBar, ReadByModal, ThreadBar } from './channel';
import { canAskReadBy, guestJoinLabel, subscribersText, threadTitle } from '../channelText';

/** Меню скрепки, как в Telegram: фото/видео, файл, музыка. */
const ATTACH_ITEMS = [
  { key: 'media', icon: 'image', label: 'Фото или видео' },
  { key: 'doc', icon: 'file', label: 'Файл' },
  { key: 'music', icon: 'music', label: 'Музыка' },
  { key: 'todo', icon: 'checkCircle', label: 'Чек-лист' },
  { key: 'date', icon: 'calendar', label: 'Дата' },
  { key: 'article', icon: 'article', label: 'Статья' },
];

/** В треде — то, что уходит комментарием (чек-лист и трек из музыки профиля отправляются без треда). */
const THREAD_ATTACH = ATTACH_ITEMS.filter((x) => x.key !== 'todo' && x.key !== 'music');

/** Дата из окна → значение для вставки: текст по умолчанию, вся строка — одна сущность даты с выбранным форматом. */
// после даты — пробел вне неё (как в Telegram): дальше набирается обычный текст, а не продолжение даты
const dateValue = (r: { date: number; format: string; label: string }) => ({ text: r.label + ' ', entities: [{ type: 'date' as const, offset: 0, length: r.label.length, date: r.date, ...(r.format ? { format: r.format } : {}) }] });
import type { LinkPreview } from '@relay/protocol';
import { membersStatus, useMembers } from '../members';
import { Playlist } from './Playlist';
import { inProfile, toggleProfileMusic, type Track } from '../music';
import { useOwnMusic } from '../profileLists';
import { Avatar, Button, Chip, Icon, MediaPolicy, peerTone, ChatSearchBar, Highlight, ripple, useMinVisible, requestMeasure, Composer, DropOverlay, GlassBar, IconButton, MenuPopover, Modal, ConfirmDialog, Presence, ReactionPicker, reducedMotion, plural, requestMutation, SelectionBar, isHeavyAnimating, onHeavyAnimationEnd, applyMarkdown, emptyValue, sameValue, voiceSupported, PlayerBar, roundSupported, startRound, Verified, canCopyImage, clipboardHtml, copyImage, copyRich, downloadUrl, TodoModal, TODO_ITEMS_MAX, DateModal, setDateCopiedToast } from '@relay/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { sendTodo, appendTodo, editTodo, closeChat, deleteMessage, editMessage, focusMessage, openInner, openUserChat, pinMessage, unpinMessage, sendFile, sendFiles, sendRound, sendVoice, react, rejectTooBig, PLAYABLE_VIDEO, retrySend, discardUnsent, saveDraft, searchMessages, send, typing, typingDone } from '../data';
import { wantPeople } from '../people';
import type { Item, SearchHit, SearchResult } from '@relay/sync-engine/src/types';
import type { Entity, Todo, TodoInput } from '@relay/protocol';

type Value = { text: string; entities: Entity[] };
type ComposerApi = { getValue(): Value; setValue(v: Value, opts?: { focus?: boolean; instant?: boolean }): void; focus(opts?: { end?: boolean }): void; insert(v: Value, range?: { start: number; end: number }): void };
import { frameByKey, setGlobal, useGlobal, getGlobal, findChat } from '../global';
import { showToast, unblockUser, useUser } from '../settingsData';
import { Feed, type MenuExtra } from './Feed';
import { chatKindFor, mediaPolicy } from '../autoload';
import { chatTime, chatTone, fileSize, isSystemChat, lastSeenText, shownBody, snippet } from './format';
import { attachmentHit } from '../searchHit';
import type { ProfilePhoto } from '@relay/protocol';
import { avatarPhoto } from '../profilePhoto';
import { openStickersPanel, sendStickerHere, setStickerTarget } from '../stickers';
import { greetingChat } from '../greeting';
import { SymbolMenu } from './stickers/SymbolMenu';
import { cancelForwardDraft, endSelect, forwardElsewhere, patchForwardDraft, sendForwardDraft, startForward, startSelect } from '../forward';


const NO_MESSAGES: Item[] = [];

/** Чат в стеке. active — он на экране: только он ловит ввод, файлы и Esc; остальные живут тихо. */
setDateCopiedToast(() => showToast('Дата скопирована'));

/** Имя файла для «Скачать»: исходное, иначе по виду (как в Telegram: voice — .ogg, кружок — .mp4, фото — .jpg). */
/** Длительность видео в окне отправки: 0:07, 17:32, 1:02:03. */
const clockDur = (sec: number) => { const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, x = String(sec % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };

/** Ячейка сетки превью проявляется, когда картинка декодирована (большие фото — не серые квадраты, а плавное появление). */
const readyCell = (e: Event) => (e.currentTarget as HTMLElement).classList.add('is-ready');
/** Сколько файлов за раз в окне отправки (уйдут альбомами по 10, как в Telegram). */
const MAX_SEND_FILES = 100;
/** У вставленного скриншота имя «image.png» — даём понятное, с датой, как Telegram Desktop. */
function namePasted(f: File): File {
  if (f.name && f.name !== 'image.png' && f.name !== 'image.jpeg') return f;
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  const ext = f.type === 'image/jpeg' ? 'jpg' : (f.type.split('/')[1] || 'png');
  return new File([f], `Снимок ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.${ext}`, { type: f.type, lastModified: f.lastModified });
}
/** «Качество» видео в окне отправки — как в Telegram: по умолчанию 720p (сжимает браузер, WebCodecs), выбор помнится на устройстве. */
const QUALITIES: [VideoQuality, string][] = [['720', '720p'], ['1080', '1080p'], ['original', 'Оригинал']];
const QUALITY_KEY = 'relay.videoQuality';
function savedQuality(): VideoQuality {
  try { const v = localStorage.getItem(QUALITY_KEY); if (v === '720' || v === '1080' || v === 'original') return v; } catch { /* приватный режим */ }
  return '720';
}
function saveQuality(q: VideoQuality): void { try { localStorage.setItem(QUALITY_KEY, q); } catch { /* приватный режим */ } }
/** Умеет ли браузер сжимать видео: проверка — с загрузки модуля, к открытию окна ответ уже есть (строка не «выпрыгивает»). */
let compressKnown: boolean | null = null;
const compressCheck = videoCompressSupported().then((v) => (compressKnown = v));
function useVideoCompress(): boolean {
  const [v, setV] = useState(compressKnown ?? false);
  useEffect(() => { if (compressKnown == null) void compressCheck.then(setV); }, []);
  return v;
}

function downloadName(a: { id?: string; kind?: string; name?: string; mime?: string }): string {
  if (a.name && a.name !== 'file') return a.name;
  const ext = a.kind === 'voice' ? 'ogg' : a.kind === 'round' ? 'mp4' : a.kind === 'photo' ? 'jpg' : (a.mime?.split('/')[1] ?? 'bin');
  return `${a.kind ?? 'file'}_${(a.id ?? '').slice(0, 8)}.${ext}`;
}

/** Комментариев в треде: число с кнопки поста (пост в канале где-то в стеке), иначе — сколько уже загружено. */
function useThreadCount(frameKey: string): number {
  return useGlobal((s) => {
    const f = frameByKey(s, frameKey);
    if (!f?.thread) return 0;
    const head = f.thread.header ? f.messages.find((m) => m.key === f.thread!.header) : undefined;
    const loaded = f.messages.length - (head ? 1 : 0);
    const o = head?.origin as { chatId: number; id: number } | undefined;
    if (o) for (const g of [...s.chatStack, ...s.chatLeaving]) {
      if (g.chatId !== o.chatId || g.threadId != null) continue;
      const r = g.messages.find((m) => m.id === o.id)?.replies as Replies | undefined;
      if (r) return Math.max(r.count, loaded);
    }
    return loaded;
  });
}

export function Chat({ chatId, frameKey, active, threadId }: { chatId: number; frameKey: string; active: boolean; threadId?: number }) {
  const me = useGlobal((s) => s.me)!;
  useOwnMusic();   // кнопка «в профиль» в плеере
  const chat = useGlobal((s) => findChat(s, chatId));
  // канал: пишут только админы с правом post (canSend); подписчику — нижняя панель. Тред — комментарии группы
  const channel = chat?.kind === 'channel';
  const community = chat?.kind === 'group' || channel;
  const thread = threadId != null;
  const threadCount = useThreadCount(frameKey);
  const threadHeader = useGlobal((s) => { const f = frameByKey(s, frameKey); return f?.thread?.header ? f.messages.find((m) => m.key === f.thread!.header) ?? null : null; });
  // тред гостя: я не участник группы обсуждения (комментирую как подписчик канала) — строки чата нет
  const guest = useGlobal((s) => (thread ? frameByKey(s, frameKey)?.thread?.guest ?? null : null));
  // тред ещё не загружен — не знаем, гость ли я: ни поля ввода, ни «Вступить» (место под ним держим), без подмены кадром позже
  const threadWaiting = useGlobal((s) => thread && !frameByKey(s, frameKey)?.thread?.loaded);
  const [readByOf, setReadByOf] = useState<number | null>(null);
  // плашка над тредом подписана каналом поста (если он в списке)
  const originTitle = useGlobal((s) => { const o = threadHeader?.origin as { chatId: number } | undefined; return o ? (s.chats.find((c) => c.id === o.chatId)?.title as string | undefined) ?? null : null; });
  const messages = useGlobal((s) => frameByKey(s, frameKey)?.messages ?? NO_MESSAGES);
  const depth = useGlobal((s) => s.chatStack.length);
  const activeRef = useRef(active); activeRef.current = active;
  // служебный чат «Relay»: только чтение — без поля ввода, реакций, ответов и вложений
  const system = isSystemChat(chat);
  const systemRef = useRef(system); systemRef.current = system;
  // «Автозагрузка медиа» / автовоспроизведение для ленты этого чата (MediaBubble кита читает контекст)
  const isContact = useGlobal((s) => chat?.peerId != null && s.contacts.some((c) => c.userId === chat.peerId));
  const autoload = useGlobal((s) => s.prefs.autoload);
  const anim = useGlobal((s) => s.prefs.anim);
  const policy = useMemo(() => mediaPolicy({ autoload, anim }, chatKindFor(chat, new Set(isContact ? [chat!.peerId as number] : []))), [autoload, anim, chat?.kind, chat?.peerId, isContact]);
  const shell = useRef<HTMLSpanElement>(null);
  const stick = useRef(true);              // лента прижата к низу (Feed ведёт, отправка выставляет)
  const [menu, setMenu] = useState<{ x: number; y: number; key: string; extra?: MenuExtra } | null>(null);
  const [fwdMenu, setFwdMenu] = useState<HTMLElement | null>(null);   // опции пересылки в поле ввода
  const [replyKey, setReplyKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; original: Value; draft: Value } | null>(null);   // правка своего сообщения
  const api = useRef<ComposerApi | null>(null);
  // запись: голосовое — если браузер умеет Opus через WebCodecs, кружок — если умеет MP4 из canvas (не Safari)
  const [recordModes, setRecordModes] = useState<string[]>([]);
  useEffect(() => { let live = true; voiceSupported().then((ok: boolean) => { if (live) setRecordModes([...(ok ? ['voice'] : []), ...(roundSupported() ? ['round'] : [])]); }); return () => { live = false; }; }, []);
  const [recordMode, setRecordMode] = useState<string>(() => { try { return localStorage.getItem('relay.recordMode') || 'voice'; } catch { return 'voice'; } });
  const [confirmDelete, setConfirmDelete] = useState<{ ids: number[] } | null>(null);
  // поиск по чату: строка вместо шапки, совпадения новые → старые, Enter — к более старому
  const [finding, setFinding] = useState(false);
  const [findQ, setFindQ] = useState('');
  const [found, setFound] = useState<{ q: string; hits: SearchHit[]; at: number } | null>(null);
  // список совпадений под строкой поиска (как в Telegram): открыт, пока печатаем; выбор или ↑↓ — сворачивает
  const [listOpen, setListOpen] = useState(true);
  const people = useGlobal((s) => s.people);
  useEffect(() => {
    const q = findQ.trim();
    if (!finding || q.length < 2) { setFound(null); return; }
    let live = true;
    // найденное на устройстве — сразу; полный ответ (с сервером) заменит, выбранное совпадение остаётся выбранным
    const show = (r: SearchResult, early: boolean) => {
      if (!live || (early && !r.hits.length)) return;
      setFound((f) => {
        const was = f?.q === q && f.at > 0 ? f.hits[f.at]?.id : undefined;   // не выбирали — снова с самого нового
        return { q, hits: r.hits, at: Math.max(0, was == null ? 0 : r.hits.findIndex((h) => h.id === was)) };
      });
      wantPeople(r.hits.map((x) => x.senderId));
    };
    const t = setTimeout(() => searchMessages(q, chatId, undefined, (r) => show(r, true)).then((r) => show(r, false)).catch(() => {}), 300);
    return () => { live = false; clearTimeout(t); };
  }, [findQ, finding]);
  const pick = (at: number) => setFound((f) => {
    if (!f || !f.hits[at]) return f;
    setListOpen(false);
    focusMessage({ id: f.hits[at].id, sort: f.hits[at].sort });
    return { ...f, at };
  });
  const step = (d: 1 | -1) => setFound((f) => {
    if (!f || !f.hits.length) return f;
    setListOpen(false);
    // первый Enter после ввода — к самому новому совпадению, дальше — по шагам
    const at = listOpen ? f.at : (f.at + d + f.hits.length) % f.hits.length;
    focusMessage({ id: f.hits[at].id, sort: f.hits[at].sort });
    return { ...f, at };
  });
  // закрытие поиска — с обратной анимацией (карточка гаснет и сжимается к правому краю), потом сброс
  const [findClosing, setFindClosing] = useState(false);
  const closeFind = () => {
    if (findClosing) return;
    if (reducedMotion()) { setFinding(false); setFindQ(''); setFound(null); setListOpen(true); return; }
    setFindClosing(true);
    setTimeout(() => { setFinding(false); setFindQ(''); setFound(null); setListOpen(true); setFindClosing(false); }, 150);
  };
  // лоадер в строке поиска: запрос ушёл, ответа на эту строку ещё нет (с задержкой и минимумом — не мигает)
  const findWant = findQ.trim();
  const searching = useMinVisible(finding && findWant.length >= 2 && found?.q !== findWant, { delay: 120, min: 450 });
  // высота списка — плавно: меряем содержимое, ставим высоту коробке (переход по height)
  const listBox = useRef<HTMLDivElement>(null);
  const listInner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = listBox.current, inner = listInner.current;
    if (!box || !inner || !listOpen) return;
    requestMeasure(() => {
      const h = Math.min(inner.scrollHeight, 360, Math.round(innerHeight * 0.55));
      requestMutation(() => { box.style.height = h + 'px'; });
    });
  }, [found, listOpen, people]);
  // Esc закрывает поиск, даже если фокус ушёл из поля (после выбора результата)
  useEffect(() => {
    if (!finding) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && activeRef.current) { e.preventDefault(); closeFind(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [finding]);

  // вложения: выбор файла (скрепка), перетаскивание, вставка; перед отправкой — окно с превью и подписью
  const picker = useRef<HTMLInputElement>(null);
  const [musicOpen, setMusicOpen] = useState(false);   // «Музыка» из меню вложений
  // чек-лист: новый (меню вложений), правка или «Добавить задачу» (меню сообщения)
  const [todoOpen, setTodoOpen] = useState<{ mode: 'create' | 'edit' | 'append'; msg?: Item } | null>(null);
  // дата: окно формата (вставка из меню вложений, правка «плашки») или выбор даты для выделенного текста (⌘D)
  const [dateOpen, setDateOpen] = useState<{ mode: 'format' | 'mark'; initial?: { date: number; format: string }; done: (r: { date: number; format: string; label: string } | null) => void } | null>(null);
  // «статья» (развёрнутый редактор): open — редактор на экране; свёрнутая «богатая» — строкой над полем ввода
  const [art, setArt] = useState<{ open: boolean; blocks: Block[]; closing?: boolean } | null>(null);
  useEffect(() => setArt(null), [chatId]);
  // окно отправки файлов: asFile — «Отправить как файл» (без превью и сжатия), spoiler — медиа размыто до нажатия
  const [pending, setPending] = useState<{ file: File; files: File[]; url: string | null; thumbs?: (string | null)[]; caption: string; asFile?: boolean; spoiler?: boolean; quality?: VideoQuality } | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const canCompress = useVideoCompress();
  const [sendMenu, setSendMenu] = useState<HTMLElement | null>(null);
  const adding = useRef(false);   // «Добавить» в окне отправки: выбранные файлы дописываются к уже выбранным
  const [pendingDur, setPendingDur] = useState(0);
  const [dragging, setDragging] = useState(false);
  // несколько файлов разом — одной группой (в ленте один пузырь); превью — только у одиночного фото
  const offer = (list: File | FileList | File[] | null | undefined) => {
    // больше 2 ГБ — сразу тост, как в Telegram: такой файл не попадёт ни в окно отправки, ни в очередь
    let files = rejectTooBig(!list ? [] : list instanceof File ? [list] : [...list]);
    if (!files.length) return;
    // «Добавить», вставка или перетаскивание при открытом окне — дописываем к уже выбранным (как в Telegram)
    const prev = pendingRef.current;
    adding.current = false;
    if (prev) { revokePending(prev); files = [...prev.files, ...files].slice(0, MAX_SEND_FILES); }
    const file = files[0];
    const isMedia = (f: File) => /^image\//.test(f.type) || PLAYABLE_VIDEO.test(f.type);
    const media = files.length === 1 && isMedia(file);
    // несколько — сетка превью (до 12), остальные — числом
    const thumbs = files.length > 1 ? files.slice(0, 12).map((f) => (isMedia(f) ? URL.createObjectURL(f) : null)) : undefined;
    setPendingDur(0);
    setPending({ file, files, url: media ? URL.createObjectURL(file) : null, thumbs, caption: prev?.caption ?? latest.current.text, asFile: prev?.asFile, spoiler: prev?.spoiler, quality: prev?.quality });
  };
  const offerRef = useRef(offer);
  offerRef.current = offer;
  // ссылки на превью — после ухода окна: оно ещё гаснет с картинками (раньше — «битые» превью и ERR_FILE_NOT_FOUND)
  const revokePending = (p: NonNullable<typeof pending>) => { const urls = [p.url, ...(p.thumbs ?? [])].filter((u): u is string => !!u); setTimeout(() => { for (const u of urls) URL.revokeObjectURL(u); }, 1000); };
  const closePending = () => { if (pending) revokePending(pending); setPending(null); };
  const sendPending = () => {
    if (!pending) return;
    if (pending.caption.trim() && !allowed('text')) return;
    for (const f of pending.files) if (!allowed(rightForKind(/^image\//.test(f.type) && !/gif/.test(f.type) ? 'photo' : /^audio\//.test(f.type) ? 'audio' : 'file', f.type))) return;
    stick.current = true;
    typingDone(chatId);
    sendFiles(chatId, pending.files, pending.caption.trim(), (replyTo?.id as number) ?? null, { asFile: pending.asFile, spoiler: pending.spoiler && !pending.asFile, quality: canCompress ? pending.quality ?? savedQuality() : 'original', ...(thread ? { threadId } : {}) }).catch(() => {});
    if (pending.caption === latest.current.text) { api.current?.setValue(emptyValue()); latest.current = saved.current = emptyValue(); }
    setReplyKey(null);
    closePending();
  };
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => { if (!activeRef.current || !hasFiles(e)) return; depth++; setDragging(true); };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const over = (e: DragEvent) => { if (activeRef.current && hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!activeRef.current || !hasFiles(e)) return;
      e.preventDefault(); depth = 0; setDragging(false);
      // папки — записи снимаются только здесь, синхронно; содержимое читаем потом
      const ents = entriesOf(e.dataTransfer!);
      if (ents) void filesFromEntries(ents).then((fs) => offerRef.current(fs));
      else offerRef.current(e.dataTransfer!.files);
    };
    // скриншот из буфера (⌘⇧4 → ⌘V) — сразу в окно отправки с превью; при открытом окне — добавится к выбранным
    const paste = (e: ClipboardEvent) => { if (!activeRef.current) return; const fs = [...(e.clipboardData?.files ?? [])]; if (fs.length) { e.preventDefault(); offerRef.current(fs.map(namePasted)); } };
    addEventListener('dragenter', enter); addEventListener('dragleave', leave); addEventListener('dragover', over); addEventListener('drop', drop); addEventListener('paste', paste);
    return () => { removeEventListener('dragenter', enter); removeEventListener('dragleave', leave); removeEventListener('dragover', over); removeEventListener('drop', drop); removeEventListener('paste', paste); };
  }, []);
  useEffect(() => { if (finding) (document.getElementById('chat-find') as HTMLInputElement | null)?.focus(); }, [finding]);


  // черновик (как в Telegram): восстановить при открытии, сохранять через 2.5 с после ввода,
  // сразу — при уходе из чата и закрытии вкладки; после отправки движок сам его очищает
  // в элементе списка черновик — строка, оформление рядом
  const draftOf = (c: Item | undefined): Value => ({ text: (c?.draft as string | null) ?? '', entities: (c?.draftEntities as Entity[] | null) ?? [] });
  const initial = useMemo<Value>(() => draftOf(chat), []);
  const saved = useRef<Value>(initial);
  const latest = useRef<Value>(initial);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDraft = () => {
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    if (editing) return;   // в поле — правка сообщения, а не черновик
    if (!sameValue(latest.current, saved.current)) { saved.current = latest.current; saveDraft(chatId, latest.current.text, latest.current.entities); }
  };
  // превью ссылки в поле ввода, как в Telegram: первая ссылка текста → через 400 мс спросить сервер; крестик — отправить без превью
  const [lp, setLp] = useState<{ url: string; link: LinkPreview | null; off: boolean } | null>(null);
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpUrl = useRef<string | null>(null);
  const watchLink = (v: Value) => {
    const url = firstUrl(v.text, v.entities as Entity[] | undefined);
    if (url === lpUrl.current) return;
    lpUrl.current = url;
    if (lpTimer.current) clearTimeout(lpTimer.current);
    if (!url) { setLp(null); return; }
    lpTimer.current = setTimeout(() => { void loadPreview(url).then((link) => { if (lpUrl.current === url) setLp((cur) => ({ url, link, off: cur?.url === url ? cur.off : false })); }); }, 400);
  };
  useEffect(() => { lpUrl.current = null; setLp(null); }, [chatId]);
  const onType = (v: Value) => {
    if (!editing) watchLink(v);
    if (v.text.trim() && v.text.length > latest.current.text.length && !editing) typing(chatId); // набирают (а не стирают) — «печатает…» у собеседника
    latest.current = v;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (!editing) draftTimer.current = setTimeout(flushDraft, 2500);
  };
  // черновик поменяли на другом устройстве (или стёрли отправкой там): здесь ничего не набирали — подхватываем
  const remoteDraft = draftOf(chat);
  const remoteKey = JSON.stringify(remoteDraft);
  useEffect(() => {
    if (editing || draftTimer.current || !sameValue(latest.current, saved.current) || sameValue(remoteDraft, latest.current)) return;
    saved.current = latest.current = remoteDraft;
    api.current?.setValue(latest.current, { instant: true });
  }, [remoteKey]);
  useEffect(() => {
    if (latest.current.text && activeRef.current) api.current?.focus({ end: true }); // курсор — в конец черновика
    addEventListener('pagehide', flushDraft);
    const hidden = () => { if (document.visibilityState === 'hidden') flushDraft(); };   // вкладку увели в фон — тоже сохранить
    document.addEventListener('visibilitychange', hidden);
    return () => { removeEventListener('pagehide', flushDraft); document.removeEventListener('visibilitychange', hidden); flushDraft(); };
  }, []);

  // правка: в поле — текст сообщения, черновик откладываем и возвращаем после
  const startEdit = (m: Item) => {
    flushDraft();
    setReplyKey(null);
    const original: Value = { text: m.body as string, entities: (m.entities as Entity[] | undefined) ?? [] };
    setEditing({ id: m.id as number, original, draft: latest.current });
    api.current?.setValue(original, { focus: true });
  };
  const endEdit = (draft: Value) => {
    setEditing(null);
    latest.current = draft;
    api.current?.setValue(draft, { focus: true });
  };
  // ↑ в пустом поле — последнее своё сообщение, которое можно править
  const editLast = () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.senderId === me.userId && m.id != null && !m.deleted && (m.kind ?? 'text') === 'text') { startEdit(m); return; }
    }
  };
  // ⌘↑ / ⌘↓ в пустом поле — выбрать сообщение для ответа (дальше конца — отменить ответ)
  const replyNav = (dir: 'older' | 'newer') => {
    const list = messages.filter((m) => m.id != null && !m.deleted);
    if (!list.length) return;
    const at = replyKey ? list.findIndex((m) => m.key === replyKey) : list.length;
    const next = dir === 'older' ? Math.max(0, at - 1) : at + 1;
    if (next >= list.length) { setReplyKey(null); return; }
    setEditing(null);
    setReplyKey(list[next].key as string);
    focusMessage({ id: list[next].id as number, sort: list[next].sort as number });
  };

  // личный чат и чёрный список: я заблокировал собеседника или он меня (флаг blocksMe считает сервер) — вместо поля ввода плашка
  const iBlocked = useGlobal((s) => chat?.kind === 'direct' && chat.peerId != null && s.blocked.some((b) => b.userId === chat.peerId));
  const peerUser = useUser(chat?.kind === 'direct' ? (chat.peerId as number | null) : null);
  const theyBlocked = !!peerUser?.blocksMe;
  // пустой личный чат встречает карточка-приветствие со стикером (писать туда должно быть можно)
  const greeting = greetingChat(chat, me.userId, { thread, blocked: iBlocked || theyBlocked });
  // группа: мои права участника (у админов — все), медленный режим, запрет копирования
  const gMe = community ? (chat?.me as MyMembership | null) ?? null : null;
  const gInfo = community ? (chat?.group as GroupInfo | null) ?? null : null;
  // гость треда — права из ответа сервера (умолчания группы или прежнее исключение)
  const gRights = guest ? guest.rights : gMe && !gMe.admin && !channel ? gMe.rights : null;
  const slowMode = gInfo?.slowMode ?? guest?.slowMode ?? 0;
  // канал без права публиковать (подписчик или не подписан) — панель «Подписаться» / «Звук» вместо поля ввода
  const channelBar = channel && !chat?.canSend;
  // правка поста редактором без права post (только edit): на время правки — поле ввода вместо панели канала
  const plate = channelBar && !editing ? 'channel' : threadWaiting ? 'wait' : guestJoinLabel(guest) && !editing ? 'join' : iBlocked ? 'mine' : theyBlocked ? 'theirs' : gRights && !gRights.text && !hasMedia(gRights) ? 'group' : null;
  // поле ввода смонтировалось только ради правки (панель канала) — startEdit не застал его, текст кладём сейчас
  useEffect(() => { if (editing && channelBar) api.current?.setValue(editing.original, { focus: true }); }, [editing?.id, channelBar]);
  /** Можно ли отправить сейчас (вид сообщения и медленный режим); нельзя — тост и false. */
  const allowed = (right: MemberRight): boolean => {
    if (gRights && !gRights[right]) { showToast(right === 'text' ? 'В этой группе нельзя отправлять текст' : `В этой группе нельзя отправлять: ${MEMBER_RIGHT_TEXT[right].toLowerCase()}`); return false; }
    if (slowMode && gRights) {
      const last = messages.filter((m) => m.senderId === me.userId && !m.service && m.id != null).pop();
      const left = last ? Math.ceil(slowMode - (Date.now() - Date.parse(last.createdAt as string)) / 1000) : 0;
      if (left > 0) { showToast(`Медленный режим: следующее сообщение — через ${left} с`); return false; }
    }
    return true;
  };

  // режим выбора сообщений (панель вместо поля ввода)
  const selKeys = useGlobal((s) => (s.selecting?.chatId === chatId ? s.selecting.keys : null));
  // высота композера (растёт с цитатой ответа) → --composer-h: лента уходит под него ровно на эту высоту
  useLayoutEffect(() => {
    const main = shell.current?.closest<HTMLElement>('.app-chatcol');   // своя колонка стека
    const wrap = main?.querySelector<HTMLElement>('.rl-composer-wrap > .rl-composer');   // в потоке обёртка фиксированной высоты — меряем само поле
    if (!main || !wrap || typeof ResizeObserver !== 'function') return;
    const feed = main.querySelector<HTMLElement>('.rl-feed');
    // композер растёт или сжимается. Во время анимации (панель ответа/правки) отступ ленты не трогаем — иначе
    // каждый кадр перестраивается вся лента: прижатую к низу ленту только сдвигаем transform'ом (композитор),
    // а настоящий отступ ставим один раз, когда анимация кончилась (сдвиг снимаем в том же кадре — без скачка)
    let committed = parseFloat(main.style.getPropertyValue('--composer-h')) || 0, target = 0, waiting = false;
    const commit = () => {
      waiting = false;
      committed = target;
      main.style.setProperty('--composer-h', target + 'px');
      if (feed) { feed.style.transform = ''; if (stick.current) feed.scrollTop = 1e9; }
    };
    const ro = new ResizeObserver(([e]) => {
      target = Math.round(e.borderBoxSize?.[0]?.blockSize ?? wrap.offsetHeight);
      if (!target) return;   // поле убрали из дерева (замена панелью выбора) — ноль не настоящая высота
      if (!committed || !isHeavyAnimating()) { requestMutation(commit); return; }
      // сдвиг — сразу, в этом же кадре (наблюдатель срабатывает до отрисовки): лента идёт ровно вместе с полем
      if (feed && stick.current) feed.style.transform = target === committed ? '' : `translateY(${committed - target}px)`;
      if (!waiting) { waiting = true; onHeavyAnimationEnd(() => requestMutation(commit)); }
    });
    ro.observe(wrap);
    return () => { ro.disconnect(); if (feed) feed.style.transform = ''; };
  }, [plate, system]);   // плашка вместо поля ввода — другой элемент

  const title = (chat?.title as string) || guest?.title || 'Чат №' + chatId;
  // как в Telegram: в норме подзаголовок — тип чата, а пока идёт подключение или обновление — стадия
  const phaseLabel = useGlobal((s) => s.syncLabel);
  const sendKey = useGlobal((s) => s.prefs.sendKey);
  const infoOpen = useGlobal((s) => s.infoOpen);
  const peer = useGlobal((s) => s.peer);
  const [, tick] = useState(0);              // «5 мин. назад» должно стареть само
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  const myPeer = peer && chat?.peerId === peer.userId && peer.known ? peer : null;
  const online = !!myPeer?.online;
  const isTyping = !!chat?.typing && !channel;   // в канале «печатает…» не показывается
  const members = useMembers(chatId, chat?.kind === 'group');
  const subtitle = thread ? title : system ? 'служебные уведомления' : isTyping ? 'печатает…' : channel ? (gInfo ? subscribersText(gInfo.members) : 'Канал') : chat?.kind === 'group' ? (members ? membersStatus(members, true) : 'Группа') : myPeer ? lastSeenText(online, myPeer.lastSeen as string | null) : '';
  const replyTo = replyKey ? messages.find((m) => m.key === replyKey) : undefined;
  // стикер из модалки пака или правой панели уходит сюда — с текущим ответом
  const replyIdRef = useRef<number | null>(null);
  replyIdRef.current = (replyTo?.id as number) ?? null;
  // цель — только у чата на экране: после «Назад» из треда стикер уходит в группу, а не в оставшийся живым тред
  useEffect(() => (active ? setStickerTarget({ chatId, ...(thread ? { threadId } : {}), replyId: () => replyIdRef.current, sent: () => setReplyKey(null) }) : undefined), [chatId, threadId, active]);
  const authorOf = (senderId: unknown) => (senderId === me.userId ? 'Вы' : title);
  const menuMsg = menu ? messages.find((m) => m.key === menu.key) : undefined;
  // пересылка, ждущая в поле ввода: «От: …» (или «Имена отправителей скрыты») и что пересылаем
  const fwd = useGlobal((s) => s.fwdDraft[chatId]) ?? null;
  const fwdQuote = fwd && !editing ? {
    icon: 'forward',
    author: fwd.hideSender ? 'Имена отправителей скрыты' : 'От: ' + fwd.preview.senders.map((s) => (s.id === me.userId ? me.name : s.name)).join(', '),
    text: fwd.preview.count > 1 ? `${fwd.preview.count} ${plural(fwd.preview.count, 'пересланное сообщение', 'пересланных сообщения', 'пересланных сообщений')}` : fwd.preview.text,
    tone: fwd.hideSender || !fwd.preview.senders.length ? peerTone(me.userId) : peerTone(fwd.preview.senders[0].id),
    onClick: (e: MouseEvent) => setFwdMenu(e.currentTarget as HTMLElement),
  } : null;
  const nameOf = (id: number) => (id === me.userId ? me.name : people[id]?.name ?? (chat?.kind === 'direct' ? title : ''));
  // «статья»: развернуть (текст поля ввода — в редактор), свернуть (простое — обратно в поле), отправить
  const openArticle = () => {
    preloadArticleEditor();
    const v = applyMarkdown(api.current?.getValue() ?? emptyValue());
    const blocks = art?.blocks ?? (v.text.trim() ? textToBlocks(v.text, v.entities) : []);
    if (!art && v.text) { api.current?.setValue(emptyValue(), { instant: true }); latest.current = saved.current = emptyValue(); }
    setArt({ open: true, blocks, closing: false });
  };
  const collapseArticle = (blocks: Block[]) => {
    const simple = blocks.length ? blocksToText(blocks) : { text: '', entities: [] };
    if (simple) {
      setArt(null);
      if (simple.text) { const v = { text: simple.text, entities: simple.entities }; api.current?.setValue(v, { instant: true }); latest.current = v; }
      setTimeout(() => api.current?.focus({ end: true }), 0);
      return;
    }
    setArt({ open: false, blocks });   // заголовки, списки… обычным текстом не записать — остаётся статьёй
  };
  const sendArticle = (blocks: Block[]) => {
    setArt(null);
    stick.current = true;
    const simple = blocksToText(blocks);
    // ответ, открытый в поле, уходит вместе со статьёй — как с любым сообщением
    const reply = (replyTo?.id as number) ?? null;
    setReplyKey(null);
    if (simple) { if (simple.text.trim()) void send(chatId, simple.text, reply, simple.entities, thread ? { threadId } : {}); return; }
    void send(chatId, blocksText(blocks), reply, [], { blocks, ...(thread ? { threadId } : {}) });
  };
  const artQuote = art && !art.open && art.blocks.length && !editing ? {
    icon: 'article', author: 'Статья', text: blocksText(art.blocks).split('\n')[0] || 'Без текста', tone: 5,
    onClick: () => setArt({ ...art, open: true, closing: false }),
  } : null;

  // «Переслать» из меню: у альбома — весь альбом
  const groupOf = (m: Item) => (m.groupId ? messages.filter((x) => x.groupId === m.groupId && x.senderId === m.senderId) : [m]);
  const forwardMenuMsg = (m: Item) => startForward(chatId, groupOf(m), nameOf);
  // режим выбора: вместо поля ввода — панель «Выбрано: N» (Переслать / Копировать / Удалить, если все свои)
  const selected = selKeys ? messages.filter((m) => selKeys.includes(m.key as string)) : [];
  useEffect(() => endSelect, [chatId]);   // ушли из чата — выбор сбрасывается
  useEffect(() => {
    if (!selKeys) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); endSelect(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [!!selKeys]);

  return (
    <>
      <span ref={shell} hidden />
      {/* плеер — остров над шапкой (как в Telegram): шапка плавно уезжает вниз, пока он открыт */}
      <PlayerBar
        onTitle={(t: Track) => { if (t.msgId != null && t.chatId) { if (t.chatId === chatId) focusMessage({ id: t.msgId, sort: t.msgId }); else openInner(t.chatId, { id: t.msgId, sort: t.msgId }); } }}
        onPlaylist={() => setGlobal({ playlistOpen: true })}
        inProfile={inProfile}
        onToggleProfile={(t: Track) => { if (t.msgId != null || inProfile(t)) void toggleProfileMusic(t); else showToast('В профиль можно добавить трек из чата'); }}
      />
      <Playlist />
      <GlassBar class={finding ? 'app-finding' : ''}>
        {/* поверх другого чата — «Назад» к нему (и на широком экране), нижний — к списку на узком */}
        <IconButton class={depth > 1 ? 'app-back app-back-inner' : 'app-back'} icon="arrowLeft" label={depth > 1 ? 'Назад' : 'К списку чатов'} onClick={closeChat} />
        <button type="button" class="rl-glassbar-who" aria-label="Информация о чате" onClick={() => setGlobal({ infoOpen: !infoOpen })}>
          <Avatar name={title} tone={chatTone(chat)} size={40} logo={system} {...avatarPhoto(chat?.photo as ProfilePhoto | null)} />
          <span class="rl-glassbar-title">
            <b>{thread ? threadTitle(threadCount) : title}{system ? <Verified size={16} /> : null}</b>
            <span key={phaseLabel ?? (isTyping ? 'typing' : online ? 'on' : 'off')} class={phaseLabel ? 'app-phase' : isTyping || online ? 'app-online' : undefined}>{phaseLabel ?? (subtitle || '\u00a0')}</span>
          </span>
        </button>
        {!thread ? <IconButton icon="search" label="Поиск по чату" onClick={() => setFinding(true)} /> : null}
        <ChatMenu chatId={chatId} title={title} />
        {/* закреплённые — под шапкой, как в Telegram (плеер — над ней); в треде вместо них — плашка поста */}
        {thread ? <ThreadBar header={threadHeader} title={originTitle ?? 'Пост'} onClick={() => { if (threadHeader?.id != null) focusMessage({ id: threadHeader.id as number, sort: threadHeader.sort as number }); }} />
          : !system ? <PinnedBar chatId={chatId} /> : null}
        {!system ? <UploadBar chatId={chatId} /> : null}
        {gInfo && gInfo.requests > 0 && !thread ? (
          <button type="button" class="app-requests-bar" onClick={() => setGlobal({ infoOpen: true, infoGo: 'gRequests' })}>
            <Icon name="userPlus" size={18} /><span>{gInfo.requests} {plural(gInfo.requests, 'заявка', 'заявки', 'заявок')} на вступление</span><Icon name="chevronRight" size={18} />
          </button>
        ) : null}
        {/* поиск по чату — карточка внутри шапки, как в Telegram: аватар и правая кнопка остаются видны */}
        {finding ? (
          <div class={'app-findcard' + (listOpen && found ? ' app-findcard-open' : '') + (findClosing ? ' app-findcard-closing' : '')}>
            <ChatSearchBar
              id="chat-find"
              variant="plain"
              value={findQ}
              total={found?.hits.length ?? 0}
              index={found?.at ?? 0}
              onQuery={(q: string) => { setFindQ(q); setListOpen(true); }}
              onFocus={() => setListOpen(true)}
              onNext={() => step(1)}
              onPrev={() => step(-1)}
              onClose={closeFind}
              busy={searching}
            />
            <Presence show={listOpen && !!found} exitMs={140}>
              <div class="app-findlist" ref={listBox} role="listbox" aria-label="Найденные сообщения"><div class="app-findlist-in" ref={listInner}>
                {found && found.hits.length ? found.hits.map((x, k) => {
                  // пост канала (senderId 0): автор — сам канал, строка с его аватаром и названием (как в Telegram)
                  const asChat = x.senderId === 0;
                  const who = asChat ? title : people[x.senderId]?.name ?? (x.senderId === me.userId ? me.name : chat?.kind === 'direct' ? title : '');
                  return (
                    <button type="button" role="option" aria-selected={k === found.at} key={x.id} class={'app-findrow' + (k === found.at ? ' app-findrow-on' : '')} onPointerDown={ripple} onClick={() => pick(k)}>
                      {asChat
                        ? <Avatar name={who} tone={chatTone(chat)} size={40} {...avatarPhoto(chat?.photo as ProfilePhoto | null)} />
                        : <Avatar name={who} tone={peerTone(x.senderId)} size={40} {...senderAvatar(x.senderId)} />}
                      <span class="app-findrow-text">
                        <span class="app-findrow-top"><b>{who}</b><time>{chatTime(x.createdAt)}</time></span>
                        <span class="app-findrow-body"><Highlight text={attachmentHit(shownBody(x), x.attachment, found.q) ?? snippet(shownBody(x), found.q)} query={found.q} /></span>
                      </span>
                    </button>
                  );
                }) : <div class="app-findempty">Ничего не найдено</div>}
              </div></div>
            </Presence>
          </div>
        ) : null}
      </GlassBar>
      <MediaPolicy.Provider value={policy}>
        <Feed frameKey={frameKey} active={active} chatId={chatId} threadId={threadId} channel={channel} meId={me.userId} peerName={title} chatPhoto={chat?.photo as ProfilePhoto | null} group={chat?.kind === 'group' || !!guest} onAuthor={openUserChat} stick={stick} greeting={greeting} highlight={found?.q} onMenu={(key, x, y, extra) => setMenu({ key, x, y, extra })} />
      </MediaPolicy.Provider>
      {plate === 'channel' ? <ChannelBar chatId={chatId} member={!!gMe} username={gInfo?.username ?? null} approval={!!gInfo?.joinApproval} requested={!!chat?.requested} />
      : plate === 'join' && guest ? <GuestJoinBar chatId={chatId} guest={guest} />
      : plate === 'wait' ? <div class="rl-composer-wrap app-plate-wrap" aria-hidden="true"><div class="rl-composer app-plate app-plate-wait" /></div>
      : plate ? (
        <div class="rl-composer-wrap app-plate-wrap">
          <div class="rl-composer app-plate" role="status" key={plate}>
            {plate === 'mine' ? (
              <>
                <span>Вы заблокировали этого пользователя</span>
                <Button variant="ghost" onClick={() => { if (chat?.peerId != null) void unblockUser(chat.peerId as number); }}>Разблокировать</Button>
              </>
            ) : plate === 'group' ? <span>Администраторы запретили писать в этой группе</span>
              : <span>Вы не можете отправлять сообщения этому пользователю</span>}
          </div>
        </div>
      ) : <div class={'app-composer-host' + (selKeys ? ' is-selecting' : '') + (art?.open && !art.closing ? ' is-article' : '')}><Composer
        id="composer"
        apiRef={api}
        symbolMenu={editing ? undefined : (close: () => void, open: boolean) => (
          <SymbolMenu
            open={open}
            onEmoji={(e) => api.current?.insert({ text: e, entities: [] })}
            onBackspace={() => {
              const v = api.current?.getValue();
              if (!v?.text) return;
              const segs = [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(v.text)];
              const cut = segs[segs.length - 1].index;
              api.current?.setValue({ text: v.text.slice(0, cut), entities: v.entities.filter((en) => en.offset + en.length <= cut) });
            }}
            onSticker={(s) => { sendStickerHere(s); close(); }}
            onSearch={() => { close(); openStickersPanel(); }}
          />
        )}
        initialValue={initial}
        captureTyping={active}
        sendKey={sendKey}
        placeholder={thread ? 'Комментарий' : channel ? 'Публикация' : 'Сообщение'}
        editing={!!editing}
        sendEmpty={!!fwdQuote || !!artQuote}
        replyTo={editing ? { author: 'Редактирование', text: editing.original.text, tone: 'accent', icon: 'pencil' } : fwdQuote ? fwdQuote : artQuote ? artQuote : !replyTo && lp?.link && !lp.off ? {
          icon: 'link', author: lp.link.siteName || lp.link.title || lp.url, text: lp.link.description || lp.link.title || lp.url, tone: 5,
          thumbSrc: lp.link.photo ? `/files/${lp.link.photo.id}` : undefined,
        } : replyTo ? { author: authorOf(replyTo.senderId), ...quoteContent(replyTo), tone: replyTo.senderId === me.userId ? 'accent' : peerTone(replyTo.senderId) } : null}
        onCancelReply={() => {
          if (editing) { endEdit(editing.draft); return; } // правку отменили — вернуть черновик
          if (fwd) { cancelForwardDraft(chatId); return; }
          if (artQuote) { setArt(null); return; }   // свёрнутую статью — выбросить
          if (!replyTo && lp?.link && !lp.off) { setLp({ ...lp, off: true }); api.current?.focus({ end: true }); return; }   // крестик у превью — отправить без него; фокус — обратно в поле
          setReplyKey(null);
        }}
        onChange={onType}
        onPickDate={(apply: (r: { date: number; format: string } | null) => void) => setDateOpen({ mode: 'mark', done: (r) => { if (r) apply(r); } })}
        onEditDate={(initial: { date: number; format: string }, range: { start: number; end: number }) => setDateOpen({ mode: 'format', initial, done: (r) => { if (r) api.current?.insert(dateValue(r), range); } })}
        onEditLast={editLast}
        onReplyNav={channel ? undefined : replyNav}
        chatKey={chatId}
        recordModes={recordModes.filter((m) => !gRights || gRights[m === 'round' ? 'round' : 'voice'])}
        startRound={startRound}
        recordMode={recordMode}
        onRecordModeChange={(m: string) => { setRecordMode(m); try { localStorage.setItem('relay.recordMode', m); } catch { /* без хранилища — до перезагрузки */ } }}
        onRecordError={(err: { name?: string }, mode: string) => showToast(err?.name === 'NotAllowedError' || err?.name === 'NotFoundError'
          ? (mode === 'round' ? 'Разрешите доступ к камере и микрофону, чтобы записывать видеосообщения' : 'Разрешите доступ к микрофону, чтобы записывать голосовые')
          : mode === 'round' ? 'Не удалось записать видеосообщение' : 'Не удалось записать голосовое')}
        onSendVoice={(r: { blob: Blob; duration: number; waveform: Uint8Array }) => { if (!allowed('voice')) return; stick.current = true; sendVoice(chatId, r, (replyTo?.id as number) ?? null, threadId).catch(() => {}); setReplyKey(null); }}
        onSendRound={(r: { blob: Blob; duration: number; size: number; thumb: string | null }) => { if (!allowed('round')) return; stick.current = true; sendRound(chatId, r, (replyTo?.id as number) ?? null, threadId).catch(() => {}); setReplyKey(null); }}
        attachItems={thread ? THREAD_ATTACH : ATTACH_ITEMS}
        onExpand={() => openArticle()}
        onAttach={(k: string) => { if (k === 'music') { if (allowed('music')) setMusicOpen(true); return; } if (k === 'article') { openArticle(); return; } if (k === 'todo') { setTodoOpen({ mode: 'create' }); return; } if (k === 'date') { setDateOpen({ mode: 'format', done: (r) => { if (r) api.current?.insert(dateValue(r)); } }); return; } const el = picker.current!; el.accept = k === 'media' || k === 'camera' ? 'image/*,video/*' : ''; el.value = ''; el.click(); }}
        onSend={(v: Value) => {
          if (editing) {
            const next = applyMarkdown(v);
            if (!sameValue(next, editing.original)) editMessage(chatId, editing.id, next.text, next.entities).catch(() => { if (channel) showToast('Не удалось изменить — недостаточно прав?'); });
            endEdit(editing.draft);
            return false;   // в поле уже черновик — композер его не трогает
          }
          if (!allowed('text')) return false;
          stick.current = true;
          if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
          saved.current = latest.current = emptyValue();   // черновик очищает сам движок вместе с отправкой
          typingDone(chatId);
          const out = applyMarkdown(v);   // **жирный**, `код`, [текст](ссылка)… — в оформление
          if (fwd) return sendForwardDraft(chatId, out.text, out.entities);   // комментарий первым, затем пересланное
          if (art) { sendArticle(art.blocks); return false; }
          // превью: убрали крестиком — без него; уже загружено для этой ссылки — сразу в ленте, до ответа сервера
          const url = firstUrl(out.text, out.entities);
          const pv = lp && url === lp.url ? (lp.off ? { noLinkPreview: true } : { link: lp.link }) : {};
          lpUrl.current = null; setLp(null);
          const sent = send(chatId, out.text, (replyTo?.id as number) ?? null, out.entities, thread ? { ...pv, threadId } : pv);
          setReplyKey(null);
          return sent;   // поле очистится, когда сообщение встанет в ленту
        }}
      />
        {art?.open ? <ArticleComposer key={chatId} blocks={art.blocks} onCollapse={collapseArticle} onSend={sendArticle} onClosing={() => setArt((a) => (a ? { ...a, closing: true } : a))} /> : null}
        {/* режим выбора: панель «Выбрано: N» проявляется поверх поля ввода (поле остаётся на месте и гаснет), как в Telegram */}
        <Presence show={!!selKeys} exitMs={200}>
          <div class="app-selbar-layer">
            <SelectionBar count={selected.length} onCancel={endSelect}
              onForward={() => { const list = selected; endSelect(); startForward(chatId, list, nameOf); }}
              onCopy={() => { navigator.clipboard?.writeText(selected.filter((m) => m.body).map((m) => m.body as string).join('\n\n')).catch(() => {}); showToast('Скопировано'); endSelect(); }}
 onDelete={selected.length && !selected.some((m) => m.origin != null) && (gMe?.admin?.delete || selected.every((m) => m.senderId === me.userId)) ? () => setConfirmDelete({ ids: selected.map((m) => m.id as number) }) : undefined} />
          </div>
        </Presence>
      </div>}
      {/* меню сообщения: левый верхний угол — у курсора, реакции — над ним (как в Telegram) */}
      {(() => {
        if (!menu || !menuMsg) return <MenuPopover open={false} />;
        // пост канала: автор скрыт (senderId 0) — править может админ с post (своё) или edit (чужое), сервер проверит;
        // копию поста в группе обсуждения не правят и не удаляют (только пост в канале)
        const postMsg = channel && !menuMsg.service;
        const copy = menuMsg.origin != null;
        const own = !copy && !menuMsg.deleted && menuMsg.id != null && (postMsg ? !!(gMe?.admin?.post || gMe?.admin?.edit) : menuMsg.senderId === me.userId);
        const canDelete = !copy && !menuMsg.deleted && menuMsg.id != null && !menuMsg.service && (own || !!gMe?.admin?.delete);
        // закреп: в канале — право post (тихий, без «уведомить всех»); в группе — право pin
        const canPin = guest ? false : channel ? !!gMe?.admin?.post : !gMe || !!gMe.admin?.pin || gMe.rights.pin;   // гость треда не закрепляет
        const att = menuMsg.attachment as { id?: string; kind?: string; name?: string; mime?: string } | null | undefined;
        const myReaction = menuMsg.reactionCounts ? menuMsg.myReaction as string | undefined : ((menuMsg.reactions as { userId: number; emoji: string }[] | undefined) ?? []).find((r) => r.userId === me.userId)?.emoji;
        // в служебном чате «Relay» уведомления — обычные пузыри с текстом: копировать и выбирать их можно (как у Telegram);
        // служебные события групп («X вступил») — плашки, у них этих пунктов нет
        const textual = !menuMsg.service || system;
        return (
          <MenuPopover open anchor={menu} class="app-msgmenu"
            header={menuMsg.id != null && !menuMsg.deleted && !system && !chat?.preview && (!gRights || gRights.react) && gInfo?.reactions.mode !== 'none' ? (
                <ReactionPicker emoji={gInfo?.reactions.mode === 'some' ? gInfo.reactions.allowed.slice(0, 7) : undefined} selected={myReaction} onPick={(emoji: string) => { react(chatId, menuMsg.id as number, myReaction === emoji ? null : emoji); setMenu(null); }} />
              ) : null}
                label="Действия с сообщением"
                onClose={() => setMenu(null)}
                items={[
                  ...(menuMsg.id != null && !menuMsg.deleted && !system && !channel ? [{ icon: 'reply', label: 'Ответить', onClick: () => { if (editing) endEdit(editing.draft); setReplyKey(menuMsg.key as string); api.current?.focus({ end: true }); } }] : []),
                  ...(own && !system && !menuMsg.blocks ? [{ icon: 'pencil', label: 'Изменить', onClick: () => { if (menuMsg.kind === 'todo') { if (!menuMsg.fwdFrom) setTodoOpen({ mode: 'edit', msg: menuMsg }); } else startEdit(menuMsg); } }] : []),
                  // чек-лист: добавить задачу — автору или всем, если автор разрешил; не больше 30
                  ...(menuMsg.kind === 'todo' && menuMsg.todo && !menuMsg.fwdFrom && menuMsg.id != null && (own || (menuMsg.todo as Todo).othersCanAppend) && (menuMsg.todo as Todo).items.length < TODO_ITEMS_MAX
                    ? [{ icon: 'plus', label: 'Добавить задачу', onClick: () => setTodoOpen({ mode: 'append', msg: menuMsg }) }] : []),
                  // как в Telegram Web A: картинка — только фото и только где буфер принимает PNG
                  ...(!menuMsg.deleted && !gInfo?.protected && att?.kind === 'photo' && att.id && canCopyImage() ? [{ icon: 'copyMedia', label: 'Копировать изображение', onClick: () => {
                    copyImage(`/files/${att.id}`).then(() => showToast('Изображение скопировано'), () => showToast('Не удалось скопировать изображение'));
                  } }] : []),
                  // по ссылке — «Копировать ссылку» вместо текста; есть выделение в этом сообщении — копируем только его
                  ...(gInfo?.protected ? [] : !menuMsg.deleted && textual && menu.extra?.link ? [{ icon: 'link', label: 'Копировать ссылку', onClick: () => {
                    copyRich(menu.extra!.link!).then(() => showToast('Ссылка скопирована'));
                  } }] : !menuMsg.deleted && textual && (menuMsg.body as string) ? [{ icon: 'copy', label: menu.extra?.selection ? 'Копировать выделенное' : 'Копировать текст', onClick: () => {
                    const v = menu.extra?.selection ?? { text: menuMsg.body as string, entities: (menuMsg.entities as Entity[] | undefined) ?? [] };
                    copyRich(v.text, clipboardHtml(v.text, v.entities)).then((ok: boolean) => showToast(ok ? 'Текст скопирован' : 'Не удалось скопировать'));
                  } }] : []),
                  ...(menuMsg.id != null && !menuMsg.deleted && !system && !menuMsg.service && canPin ? [((chat?.pinned as number[] | undefined) ?? []).includes(menuMsg.id as number)
                    ? { icon: 'pin', label: 'Открепить', onClick: () => void unpinMessage(chatId, menuMsg.id as number) }
                    : { icon: 'pin', label: 'Закрепить', onClick: () => void pinMessage(chatId, menuMsg.id as number) }] : []),
                  ...(!menuMsg.deleted && !gInfo?.protected && att?.id ? [{ icon: 'download', label: 'Скачать', onClick: () => downloadUrl(`/files/${att.id}?download=1`, downloadName(att)) }] : []),
                  ...(menuMsg.id != null && !menuMsg.deleted && !menuMsg.service && !gInfo?.protected && !guest ? [{ icon: 'forward', label: 'Переслать', onClick: () => forwardMenuMsg(menuMsg) }] : []),
                  ...(menuMsg.id != null && !menuMsg.deleted && textual && !gInfo?.protected ? [{ icon: 'checkCircle', label: 'Выбрать', onClick: () => startSelect(chatId, groupOf(menuMsg).map((x) => x.key as string)) }] : []),
                  ...(canAskReadBy(menuMsg, chat?.kind === 'group' && gInfo ? { kind: 'group', members: gInfo.members } : null, me.userId) ? [{ icon: 'markRead', label: 'Кто прочитал', onClick: () => setReadByOf(menuMsg.id as number) }] : []),
                  ...(canDelete ? ['-' as const, { icon: 'trash', label: 'Удалить', danger: true, onClick: () => setConfirmDelete({ ids: [menuMsg.id as number] }) }] : []),
                  // неотправленное (своё, без id): после отказа — «Повторить»; «Удалить» убирает его только у себя и прерывает загрузку
                  ...(menuMsg.id == null && menuMsg.senderId === me.userId && !menuMsg.deleted ? [
                    ...(menuMsg.status === 'failed' ? [{ icon: 'refresh', label: 'Повторить отправку', onClick: () => retrySend(menuMsg.key as string) }] : []),
                    '-' as const, { icon: 'trash', label: menuMsg.status === 'failed' ? 'Удалить' : 'Отменить отправку', danger: true, onClick: () => discardUnsent(menuMsg.key as string) }] : []),
                ]}
          />
        );
      })()}
      <MenuPopover open={!!(fwdMenu && fwd)} anchor={fwdMenu ?? undefined} placement="top-start"
              label="Параметры пересылки"
              onClose={() => setFwdMenu(null)}
              items={!fwd ? [] : [
                fwd.hideSender
                  ? { icon: 'eye', label: 'Показать отправителя', onClick: () => patchForwardDraft(chatId, { hideSender: false }) }
                  : { icon: 'eyeOff', label: 'Скрыть отправителя', onClick: () => patchForwardDraft(chatId, { hideSender: true }) },
                ...(fwd.preview.captions ? [fwd.hideCaption
                  ? { icon: 'eye', label: 'Показать подписи', onClick: () => patchForwardDraft(chatId, { hideCaption: false }) }
                  : { icon: 'eyeOff', label: 'Скрыть подписи', onClick: () => patchForwardDraft(chatId, { hideCaption: true }) }] : []),
                { icon: 'forward', label: 'Другой чат…', onClick: () => forwardElsewhere(chatId) },
              ]}
      />
      <MusicPicker chatId={chatId} open={musicOpen} onClose={() => setMusicOpen(false)} replyToId={(replyTo?.id as number) ?? null} onSent={() => setReplyKey(null)} />
      {dateOpen ? (
        <DateModal
          mode={dateOpen.mode} initial={dateOpen.initial}
          onClose={() => setDateOpen(null)}
          onSubmit={(r: { date: number; format: string; label: string }) => { const d = dateOpen; setDateOpen(null); d.done(r); }}
        />
      ) : null}
      {todoOpen ? (
        <TodoModal
          mode={todoOpen.mode}
          initial={todoOpen.msg?.todo as Todo | undefined}
          onClose={() => setTodoOpen(null)}
          onSubmit={(r: TodoInput & { items: { id?: number; title: string }[] | string[] }) => {
            const t = todoOpen;
            setTodoOpen(null);
            if (t.mode === 'create') { stick.current = true; void sendTodo(chatId, r as TodoInput, (replyTo?.id as number) ?? null); setReplyKey(null); return; }
            const id = t.msg!.id as number;
            const done = t.mode === 'append' ? appendTodo(chatId, id, r.items as string[]) : editTodo(chatId, id, r as TodoInput);
            done.catch(() => showToast(t.mode === 'append' ? 'Не удалось добавить задачи' : 'Не удалось изменить чек-лист'));
          }}
        />
      ) : null}
      <input ref={picker} type="file" multiple hidden onChange={(e) => { const el = e.target as HTMLInputElement; offer(el.files); el.value = ''; }} />
      <Presence show={dragging} exitMs={160}><div class="app-drop"><DropOverlay title="Отпустите, чтобы отправить" text="Фото, видео и документы до 2 ГБ" /></div></Presence>
      {pending ? (
        (() => {
        const isVideo = (f: File) => PLAYABLE_VIDEO.test(f.type), isImage = (f: File) => /^image\//.test(f.type);
        const anyMedia = pending.files.some((f) => isVideo(f) || isImage(f));
        const asFile = !!pending.asFile || !anyMedia;
        const n = pending.files.length;
        // заголовок — как в Telegram: «Отправить видео/фото», несколько — числом, документом — «как файл»
        const title = asFile ? (n > 1 ? `Отправить файлы: ${n}` : 'Отправить файл')
          : n > 1 ? (pending.files.every(isImage) ? `Отправить фото: ${n}` : `Отправить медиа: ${n}`) : isVideo(pending.file) ? 'Отправить видео' : 'Отправить фото';
        return (
        <Modal size="slim" title={title} onClose={closePending}
          headerActions={<IconButton icon="more" label="Параметры отправки" onClick={(e: MouseEvent) => setSendMenu(e.currentTarget as HTMLElement)} />}
          actions={[
          <Button key="c" variant="ghost" onClick={closePending}>Отмена</Button>,
          <Button key="s" onClick={sendPending}>Отправить</Button>,
        ]}>
          {pending.url && !asFile && isVideo(pending.file) ? (
            <div class={'app-send-media' + (pending.spoiler ? ' app-send-spoiler' : '')}>
              <video class="app-send-preview" src={pending.url} muted autoplay loop playsInline onLoadedMetadata={(e) => setPendingDur(Math.round((e.currentTarget as HTMLVideoElement).duration || 0))} />
              {pendingDur ? <span class="app-send-dur">{clockDur(pendingDur)}</span> : null}
            </div>
          ) : pending.url && !asFile ? <div class={'app-send-media' + (pending.spoiler ? ' app-send-spoiler' : '')}><img class="app-send-preview" src={pending.url} alt="" /></div> : (
            pending.thumbs && !asFile && pending.thumbs.some(Boolean) ? (
              <div class={'app-send-grid' + (pending.spoiler ? ' app-send-spoiler' : '')}>
                {pending.thumbs.map((u, i) => {
                  const f = pending.files[i];
                  const more = i === pending.thumbs!.length - 1 && pending.files.length > pending.thumbs!.length ? pending.files.length - pending.thumbs!.length : 0;
                  return (
                    <div key={i} class="app-send-cell">
                      {u && isVideo(f) ? <video src={u} muted playsInline preload="metadata" onLoadedData={readyCell} /> : u ? <img src={u} alt="" decoding="async" onLoad={readyCell} /> : <span class="app-send-cell-file"><Icon name="file" size={22} />{f.name}</span>}
                      {more ? <span class="app-send-more">+{more}</span> : null}
                    </div>
                  );
                })}
              </div>
            ) : <div class="app-send-files">{pending.files.map((f, i) => <div key={i} class="app-send-file"><b>{f.name}</b><span>{fileSize(f.size)}</span></div>)}</div>
          )}
          {canCompress && !asFile && pending.files.some(isVideo) ? (
            <div class="app-send-quality" role="radiogroup" aria-label="Качество видео">
              <span>Качество</span>
              {QUALITIES.map(([q, l]) => (
                <Chip key={q} role="radio" aria-checked={(pending.quality ?? savedQuality()) === q} active={(pending.quality ?? savedQuality()) === q}
                  onClick={() => { saveQuality(q); setPending({ ...pending, quality: q }); }}>{l}</Chip>
              ))}
            </div>
          ) : null}
          <input
            class="app-field app-send-caption"
            placeholder="Подпись"
            value={pending.caption}
            onInput={(e) => setPending({ ...pending, caption: (e.target as HTMLInputElement).value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendPending(); } }}
            autoFocus
          />
          <MenuPopover open={!!sendMenu} anchor={sendMenu ?? undefined} placement="bottom-end" label="Параметры отправки" onClose={() => setSendMenu(null)}
            items={[
              { icon: 'plus', label: 'Добавить', onClick: () => { adding.current = true; const el = picker.current!; el.accept = ''; el.value = ''; el.click(); } },
              ...(anyMedia ? [pending.asFile
                ? { icon: 'image', label: n > 1 ? 'Отправить как медиа' : isVideo(pending.file) ? 'Отправить как видео' : 'Отправить как фото', onClick: () => setPending({ ...pending, asFile: false }) }
                : { icon: 'file', label: n > 1 ? 'Отправить как файлы' : 'Отправить как файл', onClick: () => setPending({ ...pending, asFile: true }) }] : []),
              ...(anyMedia && !asFile ? [pending.spoiler
                ? { icon: 'eye', label: 'Убрать спойлер', onClick: () => setPending({ ...pending, spoiler: false }) }
                : { icon: 'eyeOff', label: 'Скрыть под спойлер', onClick: () => setPending({ ...pending, spoiler: true }) }] : []),
            ]}
          />
        </Modal>
        );
        })()
      ) : null}
      {readByOf != null ? <ReadByModal chatId={chatId} id={readByOf} onClose={() => setReadByOf(null)} /> : null}
      <ConfirmDialog open={!!confirmDelete} danger title={confirmDelete && confirmDelete.ids.length > 1 ? `Удалить ${confirmDelete.ids.length} ${plural(confirmDelete.ids.length, 'сообщение', 'сообщения', 'сообщений')}?` : 'Удалить сообщение?'}
        text={confirmDelete && confirmDelete.ids.length > 1 ? 'Сообщения исчезнут у всех участников чата.' : 'Сообщение исчезнет у всех участников чата.'} confirm="Удалить у всех"
        onCancel={() => setConfirmDelete(null)} onConfirm={() => { if (confirmDelete) for (const id of confirmDelete.ids) deleteMessage(chatId, id).catch(() => { if (community) showToast('Не удалось удалить — недостаточно прав?'); }); setConfirmDelete(null); endSelect(); }} />
    </>
  );
}
