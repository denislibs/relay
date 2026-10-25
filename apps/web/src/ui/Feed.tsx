import { isGroupService, serviceText } from './serviceText';
import type { ServiceData, ServiceType } from '@relay/protocol';
import type { Item } from '@relay/sync-engine/src/types';
import { avatarPhoto, senderAvatar } from '../profilePhoto';
import type { Entity, MessageButton, ProfilePhoto, Todo } from '@relay/protocol';
import { Presence, ProgressRing, useMinVisible, MediaPolicy, ArticleBlocks, Avatar, Bubble, Icon, peerTone, DateDivider, DatePicker, FileBubble, MediaBubble, MessageText, VoiceBubble, MusicBubble, RoundBubble, player, MediaViewer, ScrollToBottom, beginHeavyAnimation, forceMeasure, isHeavyAnimating, onHeavyAnimationEnd, requestMeasure, requestMutation, selectionValue, TodoBubble, InlineKeyboard, StickerBubble, reducedMotion, LazyRoot } from '@relay/ui';
import { openStickerSet, sendSticker, useGreetingSticker } from '../stickers';
import { historyEmpty } from '../greeting';
import { GreetingCard } from './GreetingCard';
import type { StickerRef } from '@relay/protocol';
import type { QuoteMsg } from '@relay/sync-engine/src/types';
import { quoteContent } from './preview';
import { memo } from 'preact/compat';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { pressButton, toggleTodo, clearFocus, discardUnsent, retrySend, focusMessage, openInner, jumpToDate, localPreview, markListened, moveWindow, react, savePosition, savedPosition, seen, markThreadRead, countViews, nextMention } from '../data';
import { isPost } from '@relay/sync-engine/src/channel';
import { Comments, MentionFab, postMeta } from './channel';
import { wantPeople } from '../people';
import { activeFrame, frameByKey, getGlobal, setGlobal, useGlobal, findChat } from '../global';
import { toggleMusic, trackTitle, useFileCached } from '../music';
import { showToast } from '../settingsData';
import { startForward, toggleSelect } from '../forward';
import { FileMessage } from './FileMessage';
import { isCached, keepOffline, offlineUrlNow, useKeptMedia, useOfflineUrl, warmCached } from '../downloads';
import { getPrefs } from '../prefs';
import { bubbleSrc, viewerPreview } from '../mediaGrid';
import { clock, dayKey, dayLabel, fileSize } from './format';
import { arrivals, type FeedSeen } from './appear';
import { deferShift, requestShift, rowFor, shiftWanted } from './windowShift';
import { burstAnimates, driveScroll, jumpNear, DRIVE_MS, DRIVE_OWN_MS, type Drive } from './scrollDrive';
import { interiorRemovals, mergeLeaving, LEAVE_HOLD_MS, LEAVE_MS, type Msg } from './leaving';

/*
 * Лента сообщений, устроенная как в Telegram:
 *  • в DOM — окно из двух порций; у краёв — датчики (IntersectionObserver с запасом 750 px),
 *    которые сдвигают окно на порцию, обрезая дальнюю сторону;
 *  • позиция держится по якорю: первый видимый бабл и его отступ — замер до сдвига, запись после;
 *  • строки мемоизированы: неизменённое сообщение — тот же объект, бабл не перерисовывается;
 *  • открытие — на первом непрочитанном (разделитель), на сохранённой позиции или внизу;
 *  • прочтение — по меткам под баблами, раз в 150 мс, пауза на тяжёлых анимациях;
 *  • даты «липнут» к верху и гаснут через секунду после остановки прокрутки.
 */

/** Что было под курсором при открытии меню: ссылка и выделенный кусок текста этого сообщения. */
export type MenuExtra = { link: string | null; selection: { text: string; entities: Entity[] } | null };

const EDGE = '750px';     // запас датчиков окна
const EDGE_PX = 750;
const TOP_ZONE = 72;      // шапка (48) + отступ (16) + воздух: выше — под шапкой, не «видно»
const BOTTOM = 50;        // «у низа» — ближе 50 px
const READ_EVERY = 150;   // отправка «вижу до id» не чаще
const FIRST_PAINT = 24;   // при открытии внизу первым кадром — столько последних сообщений, остальное порциями после
const FILL_CHUNK = 16;    // дорисовка истории выше первого экрана — по столько строк за кадр
const APPEAR_MS = 400;    // анимация появления нового сообщения (200 мс) + запас: дольше класс не держим

type Quote = QuoteMsg;
type Att = { id: string; kind: 'photo' | 'video' | 'file' | 'voice' | 'round' | 'audio'; spoiler?: boolean; title?: string | null; performer?: string | null; mime: string; name: string; size: number; w: number | null; h: number | null; thumb?: string | null; duration?: number | null; waveform?: string | null;
  preview?: { w: number; h: number; size: number } | null; variants?: { name: string; w: number; h: number; size: number }[] };
const fileUrl = (a: Att, download = false) => `/files/${a.id}${download ? '?download=1' : ''}`;
/** Видео после обработки сервером: в ленте — короткий немой ролик вместо оригинала (пока его нет — оригинал, как раньше). */
const inlineUrl = (a: Att) => (a.kind === 'video' && a.preview && a.id ? `/files/${a.id}/preview` : undefined);
/** Качества в просмотрщике: 720p по умолчанию, переключатель на оригинал; без копии — один оригинал. */
const qualitiesOf = (a: Att) => (a.kind === 'video' && a.variants?.some((v) => v.name === '720')
  ? [{ label: '720p', src: `/files/${a.id}/720` }, { label: 'Оригинал', src: fileUrl(a) }] : undefined);
type RowProps = { post?: boolean; pinned?: boolean; discussion?: number | null; chatId: number; voiceTitle: string; author?: string; onAuthor?: (m: Item) => void; onOpen: (m: Item) => void; hl?: string; m: Item; meId: number; out: boolean; start: boolean; end: boolean; pos?: 'single' | 'first' | 'middle' | 'last'; quoted?: Quote | null; quoteAuthor?: string; quoteTone?: number | 'accent'; appear: boolean; flash: boolean; onReact: (m: Item, emoji: string) => void; album?: Item[]; onUser?: (userId: number) => void; sel?: boolean; selIn?: string; onQuickForward?: (m: Item) => void; grp?: boolean; leaving?: boolean };

/** Строка ленты: перерисовывается только если изменилось её сообщение или место в группе. */
const Row = memo(function Row({ post, pinned, discussion, chatId, voiceTitle, author, onAuthor, onOpen, hl, m, meId, out, start, end, pos, quoted, quoteAuthor, quoteTone, appear, flash, onReact, album, onUser, sel, selIn, onQuickForward, grp, leaving }: RowProps) {
  // реакции: по эмодзи — сколько и есть ли моя
  const list = (m.reactions as { userId: number; emoji: string }[] | undefined) ?? [];
  const chips: { emoji: string; count: number; mine: boolean }[] = [];
  // пост канала — счётчиками (reactionCounts), своя — myReaction; списка реакторов у поста нет
  const counts = m.reactionCounts as [string, number][] | undefined;
  if (counts) for (const [emoji, count] of counts) chips.push({ emoji, count, mine: m.myReaction === emoji });
  else for (const r of list) {
    const c = chips.find((x) => x.emoji === r.emoji);
    if (c) { c.count++; c.mine ||= r.userId === meId; } else chips.push({ emoji: r.emoji, count: 1, mine: r.userId === meId });
  }
  // пост: в мете — просмотры, подпись автора и булавка; под пузырём — кнопка комментариев (если у канала есть обсуждение)
  const metaBefore = post && !m.deleted ? postMeta(m, !!pinned) : undefined;
  // у канала есть обсуждение (discussion) — кнопка сразу у каждого поста, заглушкой, пока не пришли replies (копия
  // в группе): иначе она появлялась позже и сдвигала пузырь
  const footer = post && (m.replies || discussion != null) && !m.deleted ? <Comments m={m} groupId={discussion} /> : undefined;
  // свой пост, ещё не подтверждённый сервером: пост всегда слева (out = false), но часы/«не отправлено» и отмена загрузки нужны
  const own = !!post && m.id == null && m.senderId === meId;
  const mineSend = out || own;
  const status = mineSend ? m.status : undefined;
  const att = m.attachment as Att | null | undefined;
  // пересланное: «Переслано от» с аватаром и именем автора. Клик (как в Telegram): оригинал доступен — к нему;
  // иначе — чат с автором, а если мы уже в нём — его профиль (панель «Информация»)
  const ff = !m.deleted ? m.fwdFrom as { userId: number | null; name: string; chatId: number; messageId: number; photo?: ProfilePhoto | null } | null | undefined : null;
  const openFwd = ff ? () => {
    const g = getGlobal();
    if (ff.chatId != null && g.chats.some((c) => c.id === ff.chatId)) { goToOriginal(ff.chatId, ff.messageId); return; }
    if (ff.userId === meId) return;
    const here = g.chats.find((c) => c.id === chatId);
    if (here?.kind === 'direct' && here.peerId === ff.userId) { setGlobal({ infoOpen: true }); return; }
    if (ff.userId != null) onUser?.(ff.userId);
  } : undefined;
  // от канала (userId null): аватар — фото канала из списка чатов, а не подписчику — снимок из fwdFrom
  const fwd = ff ? (ff.userId == null
    ? { name: ff.name, tone: peerTone(ff.chatId), avatar: avatarPhoto(getGlobal().chats.find((c) => c.id === ff.chatId)?.photo as ProfilePhoto | null ?? ff.photo), onClick: openFwd }
    : { name: ff.name, tone: peerTone(ff.userId), avatar: senderAvatar(ff.userId), onClick: openFwd }) : undefined;
  // ответ — у любого типа сообщения (как в Telegram); клик по цитате ловит лента (onClick ниже ищет .rl-quote)
  const replyQ = quoted && !m.deleted ? { author: quoteAuthor, ...quoteContent(quoted as unknown as Record<string, unknown>), tone: quoteTone, onClick: noop } : undefined;
  // режим выбора: строка отмечается кликом (обработчик — у ленты), кружок-галочка слева
  // уходящая (удалённая, пока доезжают соседи — leaving.ts): без кликов и метки прочтения, вне якорей
  const wrap = (base: string) => base + (flash ? ' app-msg-flash' : '') + (sel !== undefined ? ' app-msg-sel' : '') + (sel ? ' app-msg-on' : '') + (grp ? ' app-msg-grp' : '') + (leaving ? ' app-msg-leaving' : '');
  // круглая стрелка «Переслать» у пузыря при наведении — у медиа и длинных сообщений (не в режиме выбора)
  // у пересланного, чей исходный чат мне доступен, вместо неё — «→ к оригиналу» (как в Telegram)
  const src = ff && ff.chatId != null && getGlobal().chats.some((c) => c.id === ff.chatId) ? ff : null;
  const aside = sel !== undefined || m.id == null || m.deleted || m.service ? null
    : src ? <button type="button" class="app-fwd-quick" aria-label="Перейти к сообщению" title="Перейти к сообщению" onClick={(e) => { e.stopPropagation(); goToOriginal(src.chatId, src.messageId); }}><Icon name="arrowRight" size={20} /></button>
    : onQuickForward && (post || att || (m.body as string).length > 300)   // у поста — всегда (как в Telegram)
      ? <button type="button" class="app-fwd-quick" aria-label="Переслать" title="Переслать" onClick={(e) => { e.stopPropagation(); onQuickForward(album?.[0] ?? m); }}><Icon name="forwardFilled" size={20} /></button> : null;
  const check = sel !== undefined ? <span class="app-msg-check" aria-hidden="true"><Icon name="check" size={14} strokeWidth={3} /></span> : null;
  const pending = m.status === 'pending' && typeof m.progress === 'number' && (m.progress as number) < 1;
  const mark = m.id != null && !leaving ? <i class="app-mark" data-mid={m.id as number} aria-hidden="true" /> : null;
  if (album && album.length > 1) {
    // альбом — фото, отправленные вместе (один groupId): один пузырь с мозаикой, как в Telegram;
    // время и статус — у последнего, подпись — у первого, где она есть
    const last = album[album.length - 1];
    const cap = album.find((x) => x.body);
    const busy = album.some((x) => x.status === 'pending' && typeof x.progress === 'number' && (x.progress as number) < 1);
    return (
      <div class={wrap('app-msg app-msg-media')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <MediaBubble
          fwd={fwd} reply={replyQ}
          aside={aside}
          from={out ? 'out' : 'in'} tail={end} groupStart={start} appear={appear}
          items={album.map((x) => { const a = x.attachment as Att; const local = localPreview(x.key); return { src: local ?? (a.id ? bubbleSrc(a) : undefined), inline: local ? undefined : inlineUrl(a), thumb: a.thumb, alt: a.name, w: a.w, h: a.h, mkey: x.key, skey: x.key, kind: a.kind === 'video' ? 'video' : 'image', duration: a.duration ?? 0, spoiler: !!a.spoiler,
            sel: selIn !== undefined ? selIn.split(',').includes(x.key as string) : undefined }; })}
          state={busy ? 'loading' : 'ready'} progress={busy ? Math.min(...album.map((x) => (typeof x.progress === 'number' ? x.progress as number : 1))) : undefined}
          caption={cap ? <MessageText text={cap.body as string} entities={cap.entities as Entity[] | undefined} highlight={hl} /> : undefined}
          metaBefore={metaBefore} footer={footer}
          time={clock(last.createdAt as string)} status={mineSend ? last.status : undefined}
          onOpen={(i: number) => onOpen(album[i] ?? m)}
        />
        {album.map((x) => (x.id != null ? <i key={x.key} class="app-mark" data-mid={x.id as number} aria-hidden="true" /> : null))}
      </div>
    );
  }
  if (att && !m.deleted && (att.kind === 'photo' || att.kind === 'video') && att.w && att.h) {
    // фото и видео знают размеры заранее: рамка нужной высоты сразу, размытое превью, полная картинка — лениво;
    // видео играет в ленте без звука (своё — прямо из файла, пока грузится), с процентом и × при отправке
    const local = localPreview(m.key);
    const src = local ?? (att.id ? bubbleSrc(att) : undefined);
    return (
      <div class={wrap('app-msg app-msg-media')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <MediaBubble
          fwd={fwd} reply={replyQ}
          aside={aside}
          from={out ? 'out' : 'in'} tail={end} groupStart={start} appear={appear}
          items={[{ src, inline: local ? undefined : inlineUrl(att), thumb: att.thumb, alt: att.name, skey: m.key, kind: att.kind === 'video' ? 'video' : 'image', duration: att.duration ?? 0, spoiler: !!att.spoiler }]}
          ratio={`${att.w} / ${att.h}`} size={att.kind === 'video' ? fileSize(att.size) : undefined}
          state={pending ? 'loading' : 'ready'} progress={m.progress as number}
          onCancel={pending && mineSend ? () => discardUnsent(m.key as string) : undefined}
          caption={m.body ? <MessageText text={m.body as string} entities={m.entities as Entity[] | undefined} highlight={hl} /> : undefined}
          metaBefore={metaBefore} footer={footer}
          time={clock(m.createdAt as string)} status={status}
          onOpen={() => onOpen(m)}
        />
        {mark}
      </div>
    );
  }
  if (m.kind === 'todo' && m.todo && !m.deleted) {
    const todo = m.todo as Todo;
    // отмечать: автор — всегда, другие — если разрешено; пересланный — только для чтения
    const canToggle = m.id != null && !m.fwdFrom && (out || todo.othersCanComplete);
    return (
      <div class={(flash ? 'app-msg app-msg-flash' : 'app-msg') + (leaving ? ' app-msg-leaving' : '')} data-key={m.key} data-sort={m.sort as number}>
        <TodoBubble
          todo={todo} from={out ? 'out' : 'in'} tail={end} groupStart={start} appear={appear}
          forwarded={!!m.fwdFrom} authorName={out ? '' : voiceTitle}
          reply={replyQ}
          edited={!!m.editedAt} time={clock(m.createdAt as string)} status={status}
          metaBefore={metaBefore} footer={footer}
          canToggle={canToggle}
          onToggle={(itemId: number, done: boolean) => { void toggleTodo(chatId, m.id as number, itemId, done).then((ok: boolean) => { if (!ok) showToast('Не удалось отметить задачу'); }); }}
          onReadOnly={() => showToast(m.fwdFrom ? 'Пересланный чек-лист нельзя менять' : `${voiceTitle} не разрешил(а) другим отмечать задачи`)}
          person={(uid: number) => { const g = getGlobal(); const full = uid === meId ? g.me?.name ?? '' : g.people[uid]?.name ?? ''; return { name: uid === meId ? 'Вы' : full, fullName: full, tone: peerTone(uid), avatar: senderAvatar(uid) }; }}
        />
        {mark}
      </div>
    );
  }
  if (att && !m.deleted && att.kind === 'voice') {
    // голосовое: точка «не прослушано» — пока получатель не включил (у отправителя тоже, как в Telegram)
    const unheard = m.id != null && !m.listened;
    return (
      <div class={wrap('app-msg')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <KeptVoice
          m={m} att={att} chatId={chatId} author={voiceTitle} out={out}
          fwd={fwd} reply={replyQ}
          aside={aside}
          from={out ? 'out' : 'in'} tail={end} groupStart={start} appear={appear}
          trackKey={m.key as string} duration={att.duration ?? 0} waveform={att.waveform ?? null}
          unread={unheard} unreadIncoming={unheard && !out}
          uploading={pending} progress={m.progress as number}
          onCancel={pending && mineSend ? () => discardUnsent(m.key as string) : undefined}
          metaBefore={metaBefore} footer={footer}
          time={clock(m.createdAt as string)} status={status}
        />
        {mark}
      </div>
    );
  }
  if (att && !m.deleted && att.kind === 'round') {
    const unseen = m.id != null && !m.listened;
    return (
      <div class={wrap('app-msg')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <KeptRound
          m={m} att={att}
          fwd={fwd} reply={replyQ}
          aside={aside}
          from={out ? 'out' : 'in'} groupStart={start} appear={appear}
          thumb={att.thumb ?? null}
          duration={att.duration ?? 0} unread={unseen}
          uploading={pending} progress={m.progress as number}
          onCancel={pending && mineSend ? () => discardUnsent(m.key as string) : undefined}
          metaBefore={metaBefore} footer={footer}
          time={clock(m.createdAt as string)} status={status}
          onListened={!out && unseen ? () => markListened(chatId, m.id as number) : undefined}
        />
        {mark}
      </div>
    );
  }
  if (att && !m.deleted && att.kind === 'audio') {
    return (
      <div class={wrap('app-msg')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <CachedMusic
          fwd={fwd} reply={replyQ}
          aside={aside}
          fileId={att.id ?? undefined} from={out ? 'out' : 'in'} tail={end} groupStart={start} pos={pos}
          trackKey={m.key as string} title={att.title || trackTitle(att.name)} performer={att.performer ?? undefined} cover={att.thumb ?? undefined}
          duration={att.duration ?? 0} size={fileSize(att.size)}
          onDownload={att.id ? () => { const a = document.createElement('a'); a.href = fileUrl(att, true); a.download = att.name; a.click(); } : undefined}
          uploading={pending} progress={m.progress as number}
          onCancel={pending && mineSend ? () => discardUnsent(m.key as string) : undefined}
          metaBefore={metaBefore} footer={footer}
          time={clock(m.createdAt as string)} status={status}
          onToggle={() => {
            // плейлист — музыка загруженного окна ленты, новые сверху
            const list = (activeFrame(getGlobal())?.messages ?? []).filter((x) => !x.deleted && (x.attachment as Att | null)?.kind === 'audio' && x.id != null).reverse();
            toggleMusic(m as never, list as never, chatId);
          }}
        />
        {mark}
      </div>
    );
  }
  if (att && !m.deleted && att.id !== undefined && att.kind === 'file') {
    const ext = (att.name.split('.').pop() ?? 'file').slice(0, 4);
    return (
      <div class={wrap('app-msg')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        {/* скачивание — менеджер загрузок (частями, с кольцом, продолжением и кэшем на устройстве) */}
        <FileMessage
          file={{ id: att.id, name: att.name, mime: att.mime, size: att.size }} out={out}
          upload={m.status === 'failed' && !att.id ? 'failed' : pending || !att.id ? 'loading' : null} uploading={pending}
          fwd={fwd} reply={replyQ}
          aside={aside}
          from={out ? 'out' : 'in'} tail={end} groupStart={start}
          name={att.name} ext={ext} meta={fileSize(att.size)}
          progress={m.progress as number}
          onCancel={m.id == null && mineSend ? () => discardUnsent(m.key as string) : undefined}
          onRetry={() => retrySend(m.key as string)}
          metaBefore={metaBefore} footer={footer}
          time={clock(m.createdAt as string)} status={status}
        />
        {mark}
      </div>
    );
  }
  if (m.kind === 'sticker' && m.sticker && !m.deleted) {
    // стикер — без пузыря (как в Telegram): ответ и автор — маленьким пузырём над ним, клик — модалка пака
    const st = m.sticker as StickerRef;
    return (
      <div class={wrap('app-msg app-msg-sticker')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <StickerBubble
          from={out ? 'out' : 'in'} groupStart={start} appear={appear} aside={aside} fwd={fwd} reply={replyQ}
          author={author} authorTone={author ? peerTone(m.senderId as number) : undefined}
          sticker={st} time={clock(m.createdAt as string)} status={status}
          metaBefore={metaBefore} footer={footer}
          reactions={chips.length ? chips : undefined} onReact={(emoji: string) => onReact(m, emoji)}
          onOpen={sel === undefined ? () => openStickerSet(st.setId) : undefined}
        />
        {mark}
      </div>
    );
  }
  return (
    <div class={wrap('app-msg')} data-key={m.key} data-sort={m.sort as number}>
      {check}
      <Bubble
        fwd={fwd}
        aside={aside}
        from={out ? 'out' : 'in'}
        tail={end}
        groupStart={start}
        author={author}
        authorTone={author ? peerTone(m.senderId as number) : undefined}
        onAuthorClick={author && onAuthor ? () => onAuthor(m) : undefined}
        reply={replyQ}
        edited={!!m.editedAt && !m.deleted}
        deleted={!!m.deleted}
        link={webLink(m)}
        linkTone={out ? undefined : `var(--peer-${peerTone(m.senderId as number)})`}
        reactions={chips.length ? chips : undefined}
        onReactionClick={(emoji: string) => onReact(m, emoji)}
        metaBefore={metaBefore}
        footer={footer}
        time={clock(m.createdAt as string)}
        status={status}
        appear={appear}
        below={m.buttons !== undefined && m.id != null
          // в режиме выбора клик по кнопке выбирает сообщение (onPress нет — клик уходит ленте)
          ? ((m.service as { type?: string } | undefined)?.type === 'new_login'
            ? <LoginKeyboard rows={m.deleted ? null : m.buttons as MessageButton[][] | null} onPress={sel === undefined ? (b: MessageButton) => pressButton(chatId, m.id as number, b.data ?? '') : undefined} />
            : <InlineKeyboard rows={m.deleted ? null : m.buttons as MessageButton[][] | null} onPress={sel === undefined ? (b: MessageButton) => pressButton(chatId, m.id as number, b.data ?? '') : undefined} />)
          : undefined}
      >
        {m.blocks && !m.deleted
          ? <ArticleBlocks blocks={m.blocks} highlight={hl} />
          : <MessageText text={m.body as string} entities={m.entities as Entity[] | undefined} highlight={hl} />}
      </Bubble>
      {m.id != null ? <i class="app-mark" data-mid={m.id as number} aria-hidden="true" /> : null}
    </div>
  );
});

/** «→» у пересланного, как «Focus message» в Telegram: исходный чат открывается поверх текущего (стрелка «Назад»
 *  вернёт обратно); он уже ниже в стеке — возвращаемся к нему; тот же чат — просто прокрутка к оригиналу. */
/** Сеанс, о котором «Новый вход» (data кнопок login:<действие>:<id>). */
const loginSessionOf = (rows: MessageButton[][] | null): number | null => {
  for (const row of rows ?? []) for (const b of row) { const m = /^login:\w+:(\d+)$/.exec(b.data ?? ''); if (m) return Number(m[1]); }
  return null;
};

/**
 * Кнопки «Нового входа» — только там, где ими можно ответить: на другом устройстве, которое само подтверждено.
 * На новом устройстве (вход о нём самом) и на ещё не подтверждённом — подсказка, где подтвердить, без кнопок,
 * которые всё равно ответили бы отказом. Пока список сеансов не пришёл — ничего (не показать кнопки-обманки).
 */
function LoginKeyboard({ rows, onPress }: { rows: MessageButton[][] | null; onPress?: (b: MessageButton) => void }) {
  // свежий список сеансов, а до него — этот сеанс из прошлой загрузки (localStorage): без позднего появления под лентой
  const current = useGlobal((g) => g.sessions?.find((s) => s.current) ?? g.thisSession);
  const sid = loginSessionOf(rows);
  if (!rows || sid == null) return <InlineKeyboard rows={rows} onPress={onPress} />;   // вопрос закрыт — клавиатура уходит сама
  if (!current) return null;
  if (current.id === sid) return <div class="rl-kb-note">Это вход с этого устройства. Подтвердить его можно на устройстве, где вы уже вошли.</div>;
  if (current.unconfirmed) return <div class="rl-kb-note">Подтвердить или завершить вход можно с устройства, где вы вошли раньше.</div>;
  return <InlineKeyboard rows={rows} onPress={onPress} />;
}

function goToOriginal(chatId: number, id: number): void {
  const target = { id, sort: id };
  if (activeFrame(getGlobal())?.chatId === chatId) focusMessage(target); else openInner(chatId, target);
}

/** Превью ссылки для пузыря: готовое (не «грузится»), картинка — наш файл. */
function webLink(m: Item) {
  const l = m.link as { url: string; pending?: boolean; siteName?: string | null; title?: string | null; description?: string | null; photo?: { id: string; w: number; h: number } | null } | null | undefined;
  if (!l || l.pending || m.deleted) return undefined;
  return { url: l.url, siteName: l.siteName, title: l.title, description: l.description, photo: l.photo ? { src: `/files/${l.photo.id}`, w: l.photo.w, h: l.photo.h } : null };
}

const noop = () => {}; // цитата — кнопка; сам клик ловит лента (один обработчик на всех)

/** Трек общего плеера для голосового: своя локальная копия, иначе файл с устройства, иначе сеть. Прослушал входящее — отметка. */
function voiceTrack(m: Item, att: Att, chatId: number, author: string, out: boolean, src?: string) {
  return {
    key: m.key as string,
    kind: 'voice' as const,
    src: src ?? localPreview(m.key as string) ?? offlineUrlNow(att.id || undefined) ?? fileUrl(att),
    duration: att.duration ?? 0,
    title: author,
    subtitle: 'Голосовое сообщение',
    chatId, msgId: (m.id as number | null) ?? null,
    onListened: !out && m.id != null && !m.listened ? () => markListened(chatId, m.id as number) : undefined,
  };
}

/** Первый бабл, видимый ниже шапки, и его отступ от верха ленты (только в фазе замера). */
/** top у липкой даты (зависит от плашки закреплённого): от него считаем, где дата «прилипла». */
function dateTop(root: HTMLElement): number { const d = root.querySelector('.rl-date'); return d ? parseFloat(getComputedStyle(d).top) || 0 : 0; }

const GROUP_GAP_MS = 10 * 60_000;
/** Между a и b группа рвётся: пауза больше 10 минут или b — первое непрочитанное. */
function breaksGroup(a: Item | undefined, b: Item, unreadFrom: number | null, meId: number): boolean {
  if (!a) return true;
  if (Date.parse(b.createdAt as string) - Date.parse(a.createdAt as string) > GROUP_GAP_MS) return true;
  return unreadFrom != null && b.senderId !== meId && b.id != null && (b.id as number) > unreadFrom && (a.id == null || (a.id as number) <= unreadFrom || a.senderId === meId);
}

/** Верх строки в координатах прокрутки ленты. Не offsetTop: строки группы лежат в «пачке» (.app-run, position:
 *  relative), и offsetTop считался бы от неё — переход к сообщению в группе промахивался на высоту пачек выше. */
function topIn(root: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
}

function firstVisible(root: HTMLElement): { key: string; sort: number; top: number } | null {
  const rootTop = root.getBoundingClientRect().top;
  for (const row of root.querySelectorAll<HTMLElement>('.app-msg:not(.app-msg-leaving)')) {
    const r = row.getBoundingClientRect();
    if (r.bottom > rootTop + TOP_ZONE) return { key: row.dataset.key!, sort: Number(row.dataset.sort), top: r.top - rootTop };
  }
  return null;
}

/** Якорь для смены ширины: первое сообщение (или разделитель непрочитанных), начинающееся в видимой части. */
function viewAnchorOf(root: HTMLElement): { key: string; top: number; sort: number } | null {
  const rootTop = root.getBoundingClientRect().top;
  for (const row of root.querySelectorAll<HTMLElement>('.app-msg:not(.app-msg-leaving), .app-unread-divider')) {
    const r = row.getBoundingClientRect();
    if (r.top >= rootTop + TOP_ZONE - 1) return { key: row.dataset.key ?? 'unread', top: r.top - rootTop, sort: row.dataset.sort != null ? Number(row.dataset.sort) : -Infinity };
  }
  return null;
}
/** Строка сообщения: по ключу, а нет — та, что его содержит (альбом, разрезанный окном иначе; windowShift.rowFor). */
const rowAt = (root: HTMLElement, key: string, sort: number) => rowFor(root.querySelectorAll<HTMLElement>('.app-msg[data-sort]:not(.app-msg-leaving)'), key, sort);
const anchorEl = (root: HTMLElement, key: string) =>
  key === 'unread' ? root.querySelector<HTMLElement>('.app-unread-divider') : root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);

const NO_MESSAGES: Item[] = [];
const NO_IDS: number[] = [];

/** Музыкальный пузырь + есть ли файл в кэше (значок «скачать» в углу — только пока файла нет). */
const asFile = (att: Att) => ({ id: att.id, name: att.name, mime: att.mime, size: att.size });

/** Голосовое: файл держим на устройстве — качаем заранее (автозагрузка включена) или при первом прослушивании. */
function KeptVoice({ m, att, chatId, author, out, ...props }: { m: Item; att: Att; chatId: number; author: string; out: boolean } & Record<string, unknown>) {
  const prefs = getPrefs();
  const { src, keep } = useKeptMedia(att.id ? asFile(att) : null, att.id ? fileUrl(att) : undefined,
    { prefetch: prefs.autoload.enabled, lock: false, local: localPreview(m.key as string), maxMb: prefs.media.maxMb });
  return <VoiceBubble {...props} track={() => { keep(); return voiceTrack(m, att, chatId, author, out, src); }} />;
}

/** Кружок: на устройстве — играет оттуда; нет — из сети и докачивается целиком (заранее при автозагрузке видео или когда начали смотреть), чтобы в следующий раз без сети. */
function KeptRound({ m, att, ...props }: { m: Item; att: Att } & Record<string, unknown>) {
  const policy = useContext(MediaPolicy) as { video?: boolean } | null;
  const prefs = getPrefs();
  const { src, keep } = useKeptMedia(att.id ? asFile(att) : null, att.id ? fileUrl(att) : undefined,
    { prefetch: !!policy?.video, lock: true, local: localPreview(m.key as string), maxMb: prefs.media.maxMb });
  return <RoundBubble {...props} src={src} onPlay={keep} />;
}

function CachedMusic({ fileId, ...props }: { fileId?: string } & Record<string, unknown>) {
  const downloaded = useFileCached(fileId);
  return <MusicBubble {...props} downloaded={downloaded} />;
}

const GREET_FLIGHT_MS = 320;   // перелёт стикера-приветствия в пузырь
const GREET_LAND_MS = 120;     // сколько после посадки ждать первый кадр пузыря (плеер общий с карточкой — обычно уже есть)

export function Feed({ frameKey, active, chatId, threadId, channel = false, meId, peerName, chatPhoto, group, onAuthor, stick, onMenu, highlight, greeting = false }: {
  frameKey: string; active: boolean;   // кадр стека чатов; active — на экране (только он отмечает прочитанное)
  greeting?: boolean;   // личный чат, где пустую ленту встречает карточка-приветствие (greetingChat)
  chatId: number; meId: number; peerName: string; highlight?: string;
  chatPhoto?: ProfilePhoto | null;   // фото чата: автор поста в просмотрщике — сам канал
  threadId?: number;    // тред комментариев: прочитанность — markThreadRead, позиция — своим ключом
  channel?: boolean;    // лента канала: все сообщения — посты (слева, без автора), просмотры засчитываются по видимости
  group: boolean; onAuthor: (userId: number) => void;   // в группе — имя автора над пачкой; клик — личный чат поверх
  stick: { current: boolean };
  onMenu: (key: string, x: number, y: number, extra: MenuExtra) => void;
}) {
  const messages = useGlobal((s) => frameByKey(s, frameKey)?.messages ?? NO_MESSAGES);
  const people = useGlobal((s) => s.people);   // имена и фото авторов пришли — пачки перерисовываются
  // следующее/предыдущее голосовое этого чата — для автоперехода и кнопок плеера
  useEffect(() => {
    if (!active) return;
    player.setQueue((key: string, dir: number) => {
      const list = (frameByKey(getGlobal(), frameKey)?.messages ?? []).filter((x) => !x.deleted && (x.attachment as Att | null)?.kind === 'voice' && x.id != null);
      const i = list.findIndex((x) => x.key === key);
      const n = i < 0 ? null : list[i + dir];
      return n ? voiceTrack(n, n.attachment as Att, chatId, n.senderId === meId ? 'Вы' : peerName, n.senderId === meId) : null;
    });
  }, [chatId, peerName, active]);
  const meta = useGlobal((s) => frameByKey(s, frameKey)?.feedMeta ?? null);
  const unreadFrom = useGlobal((s) => frameByKey(s, frameKey)?.unreadFrom ?? null);
  // подписался на канал из превью: местная строка «Вы подписались на канал» после последнего поста на тот момент
  const joinedAfter = useGlobal((s) => frameByKey(s, frameKey)?.joinedAfter ?? null);
  const focus = useGlobal((s) => frameByKey(s, frameKey)?.focus ?? null);
  const activeRef = useRef(active); activeRef.current = active;
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);   // индекс фото в просмотрщике
  const [pickDate, setPickDate] = useState<Date | null>(null);   // «Перейти к дате» по клику на плашку даты
  const [pickerUsed, setPickerUsed] = useState(false);   // календарь монтируется с первого открытия: закрытый строил сетку месяца в каждом чате
  if (pickDate && !pickerUsed) setPickerUsed(true);
  const unread = useGlobal((s) => (findChat(s, chatId)?.unread as number) ?? 0);
  const el = useRef<HTMLDivElement>(null);
  // корень ленивых картинок — сама лента: наблюдатель с корнем-окном не видит строки, обрезанные прокруткой ленты,
  // и запас 500 px не работал (плитки грузились только уже в экране). Состояние — чтобы провайдер получил узел после монтирования
  const [lazyRoot, setLazyRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setLazyRoot(el.current); }, []);
  const metaRef = useRef(meta); metaRef.current = meta;
  const anchor = useRef<{ key: string; sort: number; top: number } | null>(null);   // якорь до сдвига окна
  const toBottom = useRef(false);                                     // после перехода к хвосту — вниз
  const programmatic = useRef(0);
  const placed = useRef(false);
  const [away, setAway] = useState(false);
  // дешёвый первый показ (как постепенный рендер в tt): открыли внизу — сначала хвост, выше экрана — следующим кадром
  // сколько последних сообщений показано (null — все): открыли внизу — сначала первый экран, остальное порциями
  const here = { chatId, threadId };   // слой стека: позиция прокрутки треда — своим ключом
  const [limit, setLimit] = useState<number | null>(() => (!unreadFrom && !savedPosition(here) && !focus ? FIRST_PAINT : null));
  const partial = limit != null && messages.length > limit;
  // анимация появления — только у пришедших в живую ленту (appear.ts), не у истории. Отметка живёт APPEAR_MS: потом
  // класс снимается, и строка, пересобранная позже, анимацию не повторит
  const appearAt = useRef(new Map<string, number>());
  const lastWindow = useRef<FeedSeen | null>(null);
  // удаление с анимацией (leaving.ts): удалённые из середины окна ещё один рендер рисуются на своих местах, FLIP-эффект
  // ниже выводит их из потока и довозит соседей; по таймеру буфер очищается (leaveTick — перерисовка без них)
  const viewAnchor = useRef<{ key: string; top: number; sort: number } | null>(null);   // что было вверху видимой части (для смены ширины)
  const leaving = useRef(new Map<string, Item>());
  const [leaveTick, bumpLeave] = useState(0);
  if (lastWindow.current?.list !== messages) {
    const prevList = lastWindow.current?.list as readonly Item[] | undefined;
    const now = performance.now(), next = arrivals(lastWindow.current, messages as { key: string }[], !!meta?.live && !meta.hasNewer);
    lastWindow.current = next.seen;
    for (const k of next.fresh) appearAt.current.set(k, now);
    for (const [k, t] of appearAt.current) if (now - t > APPEAR_MS) appearAt.current.delete(k);
    // не при сдвиге окна, не на первом кадре, не без анимаций и не в скрытой вкладке — тогда обычный путь (якорь)
    if (prevList && placed.current && !anchor.current && !toBottom.current && !reducedMotion() && !document.hidden) {
      // у живого края удалённое последнее — тоже удаление (а не подрезка окна); у начала истории — первое
      const edges = { atEnd: !!meta?.live && !meta.hasNewer, atStart: !!meta && !meta.hasOlder };
      // выше видимой области (до якоря ширины) — не анимируем: там нечего показывать, а якорь удержит главный эффект
      // синхронно, как раньше; ниже — буфер (вне экрана строка просто уйдёт)
      const aboveView = viewAnchor.current?.sort ?? -Infinity;
      for (const x of interiorRemovals(prevList as unknown as (Item & Msg)[], messages as unknown as (Item & Msg)[], edges)) if (x.sort > aboveView && !leaving.current.has(x.key)) leaving.current.set(x.key, x);
    }
    for (const m of messages) leaving.current.delete(m.key as string);   // вернулось в окно (повтор отправки) — не уходит
  }
  const rendered = leaving.current.size ? mergeLeaving(messages as unknown as (Item & Msg)[], leaving.current.values() as Iterable<Item & Msg>) as Item[] : messages;
  const shownKeys = useRef<Set<string> | null>(null);   // ключи прошлых строк: что из них пропало (удалили сообщение)

  /** Сдвиг окна: сначала замер якоря, потом — запрос нового окна. */
  // направление последней прокрутки пользователя: окно двигаем только туда, куда листают. Иначе на коротких
  // сообщениях окно качается — сдвиг к старым оставляет нижний датчик в зоне, он тянет к новым, и так по кругу
  const scrollDir = useRef<-1 | 0 | 1>(0);
  const lastTop = useRef(0);
  // программная плавная прокрутка (scrollDrive.ts): одна на ленту, пока едет — события scroll наши, не пользователя
  const driving = useRef<Drive | null>(null);
  const burst = useRef({ since: 0, last: 0 });   // серия сообщений подряд: после 600 мс анимации — мгновенно до паузы
  /** Можно ли ехать анимацией: без анимаций, в скрытой вкладке и в потоке сообщений — ставим сразу (как раньше). */
  const canDrive = (stream: boolean) => !reducedMotion() && !document.hidden && (!stream || burstAnimates(burst.current, performance.now()));
  /** Поехать к цели: далеко — сначала прыжок на экран от неё. Вызывать из requestMutation. Если уже едем — новая
   *  поездка открывает своё окно анимации раньше, чем закроется старое: счётчик не падает до нуля, и отложенная
   *  работа (медиа, сдвиг окна) не стартует посреди пути. */
  const drive = (root: HTMLElement, target: () => number, ms: number) => {
    if (!root.isConnected) return;
    const prev = driving.current;
    const end = beginHeavyAnimation(ms);
    prev?.cancel();
    const to = target(), from = root.scrollTop, screen = root.clientHeight;
    const me: Drive = driveScroll(root, { ms, target, start: jumpNear(from, to, screen) ?? undefined, onEnd: () => {
      end();
      if (driving.current !== me) return;   // нас сменила следующая поездка — состояние пересчитает она
      driving.current = null;
      // где остановились — пересчитать «прижата к низу» и кнопку «вниз» (события scroll драйвера пропускались,
      // счётчик своих записей за это время не нужен: драйвер всё равно переписывал позицию)
      requestMeasure(() => {
        const fromBottom = root.scrollHeight - root.scrollTop - root.clientHeight, live = metaRef.current?.live ?? true;
        lastTop.current = root.scrollTop;
        programmatic.current = 0;
        stick.current = fromBottom < BOTTOM && live;
        setAway(fromBottom > root.clientHeight || !live);
      });
    } });
    driving.current = me;
  };
  // первый ввод пользователя обрывает поездку: дальше лента его
  useEffect(() => {
    const root = el.current;
    if (!root) return;
    const stop = () => driving.current?.cancel();
    const keys = (e: KeyboardEvent) => { if (/^(Arrow(Up|Down)|Page(Up|Down)|Home|End| )$/.test(e.key)) stop(); };
    root.addEventListener('wheel', stop, { passive: true });
    root.addEventListener('touchstart', stop, { passive: true });
    root.addEventListener('pointerdown', stop);
    root.addEventListener('keydown', keys);
    return () => { root.removeEventListener('wheel', stop); root.removeEventListener('touchstart', stop); root.removeEventListener('pointerdown', stop); root.removeEventListener('keydown', keys); };
  }, [chatId]);
  useEffect(() => () => driving.current?.cancel(), []);   // размонтирование — драйвер не пишет в мёртвый узел
  // во время тяжёлой анимации сдвиг ждёт её конца (deferShift): перераскладка ленты съедала бы кадры перехода
  const pendingShift = useRef<{ dirs: Set<'older' | 'newer'> }>({ dirs: new Set() });
  const shift = (dir: 'older' | 'newer') => deferShift(pendingShift.current, dir, isHeavyAnimating(), onHeavyAnimationEnd, (d) => {
    const root = el.current;
    if (!root || !placed.current || !shiftWanted(d, metaRef.current, scrollDir.current)) return;
    requestMeasure(() => {
      if (anchor.current) return; // предыдущий сдвиг ещё не применён
      // окно не двинулось (край в кадре уже пуст — лента не успела перерисоваться; прежний сдвиг в пути) — якорь
      // не держим: он ждал бы окна, которое не придёт, и окно встало бы в обе стороны
      anchor.current = requestShift(() => firstVisible(root), () => moveWindow(d, frameKey));
    });
  });

  // после каждого обновления окна: первая раскладка, якорь или «прилипание» к низу
  useLayoutEffect(() => {
    const root = el.current;
    if (!root || !messages.length) return;
    const before = shownKeys.current, keys = new Set(rendered.map((m) => m.key as string));
    shownKeys.current = keys;
    if (!placed.current) {
      placed.current = true;
      // первый кадр чата — до отрисовки (осознанное исключение): сохранённая позиция → непрочитанное → низ
      forceMeasure(() => {
        const divider = root.querySelector<HTMLElement>('.app-unread-divider');
        const pos = savedPosition(here);
        const bottom = root.scrollHeight - root.clientHeight;
        let target = bottom;
        const row = pos ? rowAt(root, pos.key, pos.sort) : null;
        // вернулись в чат, из которого ушли посреди истории, — туда же; иначе к первому непрочитанному
        if (row) target = Math.min(bottom, topIn(root, row) - pos!.offset);
        else if (divider) target = Math.min(bottom, divider.offsetTop - TOP_ZONE - 10);
        stick.current = target >= bottom - BOTTOM && !!metaRef.current?.live;
        target = Math.max(0, target);
        if (Math.abs(root.scrollTop - target) > 1) { programmatic.current++; root.scrollTop = target; }
        viewAnchor.current = viewAnchorOf(root);
      });
      return;
    }
    const a = anchor.current, down = toBottom.current;
    if (!a && !down && !stick.current) {
      // сообщение удалили (пропало из окна без его сдвига): что было вверху видимой части, там и остаётся — удалённое
      // выше экрана не дёргает ленту, удалённое на экране просто уходит, и нижние поднимаются на его место
      const va = viewAnchor.current;
      if (!va || !before || ![...before].some((k) => !keys.has(k))) return;
      forceMeasure(() => {   // одно чтение и одна запись до отрисовки — иначе кадр со сдвинутой лентой
        const row = anchorEl(root, va.key);
        if (!row) return;   // удалили саму верхнюю строку — держится та, что над ней
        const top = root.scrollTop, max = root.scrollHeight - root.clientHeight;
        const next = Math.max(0, Math.min(max, top + (row.getBoundingClientRect().top - root.getBoundingClientRect().top) - va.top));
        if (Math.abs(next - top) > 0.5) { programmatic.current++; root.scrollTop = next; }
      });
      return;
    }
    // пришло новое в живую ленту, прижатую к низу (свежие — из arrivals этого рендера) — доезжаем, как Telegram,
    // а не прыгаем: контент остаётся на месте, лента едет к новому низу. Остальное (якорь, «вниз», перераскладка
    // при stick) — как раньше, одним кадром
    const fresh = [...appearAt.current.keys()].filter((k) => !before?.has(k));
    if (!a && !down && stick.current && fresh.length > 0 && (metaRef.current?.live ?? true) && canDrive(true)) {
      const own = fresh.every((k) => messages.find((m) => m.key === k)?.senderId === meId);
      // кадр за стеком (скрытый) не едет: там нечего анимировать, а окно анимации задержало бы медиа видимого чата
      requestMutation(() => { if (activeRef.current) drive(root, () => root.scrollHeight - root.clientHeight, own ? DRIVE_OWN_MS : DRIVE_MS); });
      return;
    }
    // как «forced reflow» в Telegram: поправить прокрутку в том же коммите, до отрисовки — иначе
    // браузер успеет показать кадр со сдвинутым контентом. Одно чтение и одна запись (осознанное исключение)
    forceMeasure(() => {
      const h = root.scrollHeight, top = root.scrollTop, ch = root.clientHeight;
      let next: number | null = null;
      if (a) {
        anchor.current = null;
        const row = rowAt(root, a.key, a.sort);
        if (row) next = top + (row.getBoundingClientRect().top - root.getBoundingClientRect().top) - a.top;
      } else if (down || (stick.current && top + ch < h - 1)) {
        toBottom.current = false;
        next = h;
      }
      const max = h - ch;
      if (next !== null) next = Math.max(0, Math.min(next, max)); // за пределы браузер не прокрутит — и события не будет
      if (next !== null && Math.abs(next - top) > 0.5) { programmatic.current++; root.scrollTop = next; }
    });
  }, [messages, limit, leaveTick]);   // каждая порция дорисовки — восстановить якорь; уход строк из буфера — тоже

  // удаление с анимацией: уходящие строки ещё в потоке — снять раскладку, вывести их из потока (absolute на своём
  // месте в пачке) и довезти соседей FLIP-переводом; уходящая гаснет. Одно чтение раскладки и одна запись до
  // отрисовки — осознанное исключение §1 SMOOTH-UI: иначе кадр со схлопнувшимися соседями. Куда сдвинутся соседи,
  // не перемеряем, а считаем: строки ниже уходящей поднимаются ровно на её высоту (соседи уже перегруппированы в
  // этом рендере), у прижатой ленты прокрутка подрежется, и всё опустится на величину подрезки. Вне экрана — без
  // анимации, строка просто уходит. По таймеру буфер очищается, а якорь ширины снимается заново — соседи уже на
  // новых местах, и уход строк из DOM ничего не сдвигает. Метки performance: relay:leave-measure / relay:leave-start
  const leavePlayed = useRef(new Set<string>());
  // прокрутка, которую подрезала или выставила уборка уходящих: событие scroll с этим значением — наше, не пользователя
  // (по значению, а не счётчиком: подрезка у низа события может и не дать, и счётчик проглотил бы чужую прокрутку)
  const leaveScroll = useRef<number | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const root = el.current;
    if (!root || !leaving.current.size) return;
    const fresh = new Set([...leaving.current.keys()].filter((k) => !leavePlayed.current.has(k)));
    if (!fresh.size) return;
    for (const k of fresh) leavePlayed.current.add(k);
    // чистим только свои ключи: следующий залп, пришедший перед самым сбросом, доживёт свою анимацию
    const mine = [...fresh];
    const drop = () => {
      leaveTimer.current = null;
      requestMeasure(() => { viewAnchor.current = viewAnchorOf(root); requestMutation(() => { for (const k of mine) { leaving.current.delete(k); leavePlayed.current.delete(k); } bumpLeave((n) => n + 1); }); });
    };
    const schedule = (ms: number) => { if (leaveTimer.current) clearTimeout(leaveTimer.current); leaveTimer.current = setTimeout(drop, ms); };
    const t0 = performance.now();
    forceMeasure(() => {
      const rr = root.getBoundingClientRect(), st = root.scrollTop, ch = root.clientHeight, sh = root.scrollHeight;
      // только строки около экрана: ±100 px — дальше сдвиги не видны. Один проход, один прямоугольник на строку
      const near: { r: HTMLElement; key: string; rect: DOMRect }[] = [];
      for (const r of root.querySelectorAll<HTMLElement>('.app-msg')) {
        const rect = r.getBoundingClientRect();
        if (rect.top > rr.bottom + 100 || rect.bottom < rr.top - 100) continue;
        near.push({ r, key: r.dataset.key!, rect });
      }
      const going = near.filter((x) => fresh.has(x.key));
      const seen = going.some((x) => x.rect.bottom > rr.top && x.rect.top < rr.bottom);
      performance.measure('relay:leave-measure', { start: t0 });
      if (!seen) {
        // всё ниже экрана: убрать сразу, у низа — остаться у низа; сам сброс буфера — следующим рендером
        for (const k of fresh) { const r = root.querySelector<HTMLElement>(`.app-msg[data-key="${CSS.escape(k)}"]`); if (r) r.style.display = 'none'; }
        const max = root.scrollHeight - ch;
        if (stick.current && Math.abs(max - root.scrollTop) > 0.5) { root.scrollTop = max; leaveScroll.current = root.scrollTop; }
        schedule(0);
        return;
      }
      // куда всё сдвинется после вывода уходящих из потока — без второго пересчёта раскладки
      const removed = going.reduce((n, x) => n + x.rect.height, 0);
      const clamp = Math.max(0, st - Math.max(0, sh - removed - ch));   // подрезка прокрутки у низа: контент опустится
      const above = (top: number) => going.reduce((n, x) => n + (x.rect.top < top ? x.rect.height : 0), 0);
      for (const x of going) { const style = x.r.style; style.position = 'absolute'; style.top = x.r.offsetTop + 'px'; style.left = x.r.offsetLeft + 'px'; style.width = x.r.offsetWidth + 'px'; }
      if (clamp > 0) leaveScroll.current = st - clamp;
      beginHeavyAnimation(LEAVE_HOLD_MS);
      const ease = 'cubic-bezier(0.2, 0, 0, 1)';
      for (const x of near) {
        if (fresh.has(x.key) || leaving.current.has(x.key)) continue;
        const d = above(x.rect.top) - clamp;   // было − стало
        if (Math.abs(d) > 1) x.r.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: LEAVE_MS, easing: ease });
      }
      // уходящая гаснет там, где была: при подрезке всё (и absolute тоже) опустилось — держим её тем же переводом
      const at = clamp > 1 ? `translateY(${-clamp}px)` : '';
      for (const x of going) x.r.animate([{ opacity: 1, transform: at || 'none' }, { opacity: 0, transform: `${at} scale(0.96)`.trim() }], { duration: LEAVE_MS - 20, easing: 'ease-in', fill: 'forwards' });
      schedule(LEAVE_HOLD_MS);
    });
    performance.measure('relay:leave-start', { start: t0 });
  });
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);

  // пустой личный чат: карточка-приветствие — только когда пустоту подтвердило окно ленты и стикер выбран
  // (или ждать его дольше секунды не стали), чтобы ничего не мелькнуло и карточка не выросла после показа
  const greetSticker = useGreetingSticker(frameKey, greeting && !messages.length);
  const greetReady = greeting && greetSticker !== undefined;
  const greetShown = greetReady && historyEmpty(meta, messages.length);
  const flight = useRef<{ id: number; from: HTMLElement } | null>(null);
  const onGreet = (st: StickerRef, from: HTMLElement) => {
    if (flight.current) return;   // второй клик, пока первый стикер в пути
    flight.current = { id: st.id, from };
    void sendSticker(chatId, st);
  };
  // пришёл свой стикер-приветствие: стикер карточки (он уже играет) перелетает на место пузыря, пузырь скрыт до
  // посадки, карточка вокруг гаснет. Осознанное исключение до отрисовки (после якоря выше): одно чтение и одна
  // запись — иначе мелькнул бы кадр с пузырём внизу и стикером на карточке одновременно
  useLayoutEffect(() => {
    const f = flight.current, root = el.current;
    if (!f || !root) return;
    const m = messages.find((x) => x.kind === 'sticker' && x.senderId === meId && (x.sticker as StickerRef | null)?.id === f.id);
    if (!m) return;
    flight.current = null;
    const box = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(m.key as string)}"] .rl-sticker-box`);
    const target = box?.querySelector<HTMLElement>('.rl-sticker');
    if (!box || !target) return;
    forceMeasure(() => {
      const from = f.from.getBoundingClientRect(), to = target.getBoundingClientRect();
      if (reducedMotion() || !from.width) { f.from.style.visibility = 'hidden'; return; }
      box.style.visibility = 'hidden';
      f.from.parentElement?.classList.add('is-flying');
      beginHeavyAnimation(GREET_FLIGHT_MS);
      const a = f.from.animate([
        { transformOrigin: '0 0', transform: 'none' },
        { transformOrigin: '0 0', transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width})` },
      ], { duration: GREET_FLIGHT_MS, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'forwards' });
      // посадка: подменяем летевший стикер пузырём, когда у пузыря уже нарисован кадр анимации (иначе мелькнёт
      // силуэт); ждём не дольше GREET_LAND_MS — карточку Presence держит до конца ожидания
      const landBy = performance.now() + GREET_FLIGHT_MS + GREET_LAND_MS;
      const land = () => {
        if (!target.classList.contains('rl-sticker-ready') && performance.now() < landBy) { requestAnimationFrame(land); return; }
        requestMutation(() => { box.style.visibility = ''; f.from.style.visibility = 'hidden'; });
      };
      a.onfinish = land;
    });
  }, [messages]);

  // Строки выше первого экрана — когда колонка на экране и переход стека закончился: в скрытой колонке их не видно,
  // а во время перехода их рендер съедал бы кадры анимации. И порциями по FILL_CHUNK за кадр: одна большая задача
  // сразу после перехода тормозила бы прокрутку и ввод. Якорь — первый видимый: позиция не прыгнет.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    if (limit == null || !hasMessages) return;   // снимка ещё нет — ждём его
    if (!partial) { setLimit(null); return; }
    if (!active) return;
    let alive = true;
    onHeavyAnimationEnd(() => requestMeasure(() => {
      const root = el.current;
      if (!alive || !root) return;
      const v = firstVisible(root);
      if (v) anchor.current = v;
      requestMutation(() => { if (alive) setLimit((l) => (l == null || l + FILL_CHUNK >= messages.length ? null : l + FILL_CHUNK)); });
    }));
    return () => { alive = false; };
  }, [limit, partial, active, hasMessages]);

  // высота ленты меняется сверху (выезжает плеер) или снизу (растёт поле ввода) — держим низ на месте, как в Telegram:
  // что было у нижнего края, там и остаётся. Ширина меняется (открыли «Информацию», тянут край сайдбара) — текст
  // переносится иначе и всё выше съезжает: возвращаем на прежнее место то, что было вверху видимой части.
  // Колбэк ResizeObserver — после раскладки, до отрисовки, без лишнего кадра
  useEffect(() => {
    const root = el.current;
    if (!root) return;
    // начальный размер — из первого вызова наблюдателя (он приходит сразу после раскладки), а не чтением при монтировании
    let last = -1, lastW = -1;
    const ro = new ResizeObserver(() => {
      const ch = root.clientHeight, cw = root.clientWidth;
      if (last < 0) { last = ch; lastW = cw; return; }
      const d = last - ch, widened = cw !== lastW;
      last = ch; lastW = cw;
      if ((!d && !widened) || !placed.current) return;
      const max = root.scrollHeight - ch;
      let next = stick.current ? max : Math.max(0, Math.min(max, root.scrollTop + d));
      const a = viewAnchor.current, row = widened && !stick.current && a ? anchorEl(root, a.key) : null;
      if (row) next = Math.max(0, Math.min(max, root.scrollTop + (row.getBoundingClientRect().top - root.getBoundingClientRect().top) - a!.top));
      if (Math.abs(next - root.scrollTop) > 0.5) { programmatic.current++; root.scrollTop = next; }
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // датчики у краёв окна: видны с запасом 750 px — сдвигаем окно; новые датчики (по ключу) срабатывают сразу
  const edges = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    edges.current = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) shift((e.target as HTMLElement).dataset.dir as 'older' | 'newer');
    }, { root: el.current, rootMargin: `${EDGE} 0px` });
    return () => edges.current?.disconnect();
  }, [chatId]);

  // колёсико у предела прокрутки: scrollTop уже упёрся — событий scroll нет, а датчик края мог сработать, пока
  // листали в другую сторону (и сдвиг тогда не начался). Направление — по колёсику, сдвиг — туда, куда крутят
  useEffect(() => {
    const root = el.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return;
      const dir = e.deltaY < 0 ? -1 : 1;
      requestMeasure(() => {
        const top = root.scrollTop, fromBottom = root.scrollHeight - top - root.clientHeight;
        if (dir < 0 ? top > 1 : fromBottom > 1) return;   // не у предела — сдвиг начнёт onScroll
        scrollDir.current = dir;
        shift(dir < 0 ? 'older' : 'newer');
      });
    };
    root.addEventListener('wheel', onWheel, { passive: true });
    return () => root.removeEventListener('wheel', onWheel);
  }, [chatId]);

  const scheduleRead = useRef<(() => void) | null>(null);   // вернулись к чату (верхний сняли) — отметить то, что видно
  // прочтение: метки под баблами (видна нижняя кромка — прочитано), отправка раз в 150 мс, пауза на тяжёлых анимациях
  const marks = useRef<IntersectionObserver | null>(null);
  const visible = useRef(new Set<number>());
  const viewed = useRef(new Set<number>());   // уже отданные в просмотры (движок тоже не повторяет — здесь без лишних вызовов)
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const flush = () => {
      readTimer.current = null;
      if (isHeavyAnimating()) { onHeavyAnimationEnd(flush); return; }
      if (!activeRef.current || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      let max = 0;
      for (const id of visible.current) if (id > max) max = id;
      // тред — своя прочитанность (точка у кнопки поста); основную ленту группы он не читает
      if (max) { if (threadId != null) markThreadRead(chatId, threadId, max); else seen(chatId, max); }
      // канал: видимые посты — в просмотры (каждый — один раз за сессию; батч раз в секунду — в движке);
      // превью без подписки — не считаем и не запоминаем: подпишется — посты на экране засчитаются
      if (channel && !findChat(getGlobal(), chatId)?.preview) {
        const fresh = [...visible.current].filter((id) => !viewed.current.has(id));
        for (const id of fresh) viewed.current.add(id);
        countViews(chatId, fresh);
      }
    };
    const schedule = () => { if (!readTimer.current) readTimer.current = setTimeout(flush, READ_EVERY); };
    // низ зоны — верх композера: лента уходит под него на свой нижний отступ (--bottom-zone + 8 px), а он
    // меняется вместе с высотой композера. Число здесь отрезало последнее сообщение, и оно не читалось никогда.
    // Чтение стиля до отрисовки — осознанное исключение, как у якоря прокрутки
    let underComposer = 0;
    forceMeasure(() => { if (el.current) underComposer = Math.max(0, parseFloat(getComputedStyle(el.current).paddingBottom) - 8); });
    marks.current = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = Number((e.target as HTMLElement).dataset.mid);
        if (e.isIntersecting) visible.current.add(id); else visible.current.delete(id);
      }
      schedule();
    }, { root: el.current, rootMargin: `-${TOP_ZONE}px 0px -${underComposer}px 0px` });
    addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', schedule);
    scheduleRead.current = schedule;
    return () => {
      marks.current?.disconnect();
      if (readTimer.current) clearTimeout(readTimer.current);
      removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [chatId]);

  useEffect(() => { if (active) scheduleRead.current?.(); }, [active]);

  // наблюдать новые датчики и метки, отпускать ушедшие из окна
  const watched = useRef(new Set<Element>());
  useEffect(() => {
    const root = el.current;
    if (!root) return;
    for (const t of watched.current) if (!t.isConnected) { edges.current?.unobserve(t); marks.current?.unobserve(t); watched.current.delete(t); }
    root.querySelectorAll('.app-sentinel').forEach((t) => { if (!watched.current.has(t)) { edges.current?.observe(t); watched.current.add(t); } });
    root.querySelectorAll('.app-mark').forEach((t) => { if (!watched.current.has(t)) { marks.current?.observe(t); watched.current.add(t); } });
  });

  // «липкие» даты: пока листают — видны; через секунду тишины прилипшие гаснут
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrolling = useRef(false);
  // как в Telegram: наверху видна только дата текущего дня; прилипшие раньше прячутся (иначе лежат стопкой),
  // а подъезжающая следующая дата выталкивает текущую вверх
  const pushing = useRef(false);
  const pushDates = (root: HTMLElement) => {
    if (pushing.current) return;
    pushing.current = true;
    requestMeasure(() => {
      pushing.current = false;
      const stickAt = root.getBoundingClientRect().top + parseFloat(getComputedStyle(root).paddingTop) + dateTop(root);
      const dates = [...root.querySelectorAll<HTMLElement>('.rl-date')];
      const tops = dates.map((d) => d.getBoundingClientRect().top);
      let cur = -1;
      tops.forEach((t, i) => { if (t <= stickAt + 2) cur = i; });
      const h = cur >= 0 ? dates[cur].offsetHeight : 0;
      const gap = cur >= 0 && cur + 1 < dates.length ? tops[cur + 1] - stickAt : Infinity;
      const shift = gap < h ? gap - h : 0;
      requestMutation(() => dates.forEach((d, i) => {
        d.classList.toggle('covered', i < cur);
        d.style.transform = i === cur && shift ? `translateY(${shift}px)` : '';
      }));
    });
  };

  const onScrollDates = (root: HTMLElement) => {
    if (!scrolling.current) {
      scrolling.current = true;
      requestMutation(() => root.querySelectorAll('.rl-date.stuck').forEach((d) => d.classList.remove('stuck')));
    }
    pushDates(root);
    if (quiet.current) clearTimeout(quiet.current);
    quiet.current = setTimeout(() => {
      scrolling.current = false;
      requestMeasure(() => {
        const stickAt = root.getBoundingClientRect().top + parseFloat(getComputedStyle(root).paddingTop) + dateTop(root); // padding ленты + top у .rl-date
        const stuck = [...root.querySelectorAll<HTMLElement>('.rl-date')].filter((d) => Math.abs(d.getBoundingClientRect().top - stickAt) < 3);
        requestMutation(() => stuck.forEach((d) => d.classList.add('stuck')));
      });
    }, 1000);
  };

  // позиция чата — запоминаем через 200 мс после остановки прокрутки
  const posTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storePosition = (root: HTMLElement) => {
    const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < BOTTOM && (metaRef.current?.live ?? true);
    const v = atBottom ? null : firstVisible(root);
    savePosition(here, v ? { key: v.key, sort: v.sort, offset: v.top } : null);
  };
  // уходим из чата, а сохранение ещё ждёт паузы — сохранить сейчас (DOM ещё на месте)
  useLayoutEffect(() => () => {
    const root = el.current;
    if (posTimer.current && root) { clearTimeout(posTimer.current); forceMeasure(() => storePosition(root)); }
  }, []);
  function onScroll() {
    const root = el.current!;
    onScrollDates(root);
    requestMeasure(() => { viewAnchor.current = viewAnchorOf(root); });   // после любой прокрутки, и нашей тоже
    // позицию — после любой прокрутки, в том числе нашей (после сдвига окна якорь тоже меняется)
    if (posTimer.current) clearTimeout(posTimer.current);
    posTimer.current = setTimeout(() => { posTimer.current = null; requestMeasure(() => storePosition(root)); }, 200);
    // всё чтение — в фазе measure: в самом событии раскладку мог «испачкать» любой код до него (картинка, патч ленты),
    // и чтение scrollTop пересчитывало бы её. Колбэки идут в порядке событий, счётчик нашей прокрутки не сбивается
    requestMeasure(() => {
      if (driving.current) { lastTop.current = root.scrollTop; return; }   // едем сами: направление, низ и сдвиги не трогаем
      const top = root.scrollTop, prev = lastTop.current;
      lastTop.current = top;
      if (leaveScroll.current != null) { const at = leaveScroll.current; leaveScroll.current = null; if (Math.abs(top - at) < 1) return; }   // подрезка после удаления — не пользователь
      if (programmatic.current > 0) { programmatic.current--; return; } // наша прокрутка не меняет «прижата к низу»
      if (top !== prev) scrollDir.current = top < prev ? -1 : 1;
      const fromBottom = root.scrollHeight - top - root.clientHeight;
      // датчик края уже в зоне (его пропустили, пока листали в другую сторону) — сдвигаем по прокрутке
      if (scrollDir.current < 0 && top < EDGE_PX) shift('older');
      else if (scrollDir.current > 0 && fromBottom < EDGE_PX) shift('newer');
      const live = metaRef.current?.live ?? true;
      stick.current = fromBottom < BOTTOM && live;
      setAway(fromBottom > root.clientHeight || !live);
    });
  }

  const toLatest = () => {
    stick.current = true;
    const root = el.current!;
    if (metaRef.current && !metaRef.current.live) { toBottom.current = true; moveWindow('latest', frameKey); return; }
    const target = () => root.scrollHeight - root.clientHeight;
    if (!canDrive(false)) { requestMeasure(() => { const top = target(); requestMutation(() => { programmatic.current++; root.scrollTop = top; }); }); return; }
    requestMutation(() => drive(root, target, DRIVE_MS));
  };

  // переход к сообщению: строка в окне — плавно к ней (по центру) и подсветить; нет — ждём новое окно
  useLayoutEffect(() => {
    const root = el.current;
    if (!root || !focus || !placed.current) return;
    const row = root.querySelector<HTMLElement>(`.app-msg[data-sort="${focus.sort}"]:not(.app-msg-leaving)`);
    if (!row) return;
    clearFocus(frameKey);
    stick.current = false;
    anchor.current = null;
    setFlashKey(row.dataset.key!);
    if (focus.replaced) {
      // окно заменили целиком — сразу по центру, до отрисовки (иначе кадр со старой позицией и долгая прокрутка)
      forceMeasure(() => {
        const top = Math.max(0, topIn(root, row) - (root.clientHeight - row.offsetHeight) / 2);
        if (Math.abs(root.scrollTop - top) > 1) { programmatic.current++; root.scrollTop = top; }
      });
    } else {
      const target = () => Math.max(0, topIn(root, row) - (root.clientHeight - row.offsetHeight) / 2);
      if (!canDrive(false)) { requestMeasure(() => { const top = target(); requestMutation(() => { programmatic.current++; root.scrollTop = top; }); }); return; }
      requestMutation(() => {
        // как в Telegram: далеко — сначала прыжок почти к цели (jumpNear внутри drive), плавно — только последний
        // экран (иначе прокрутка пролетает десятки пузырей и кружков, каждый из которых просыпается — кадры
        // проседают). Пока едем — тяжёлая анимация: кружки не запускают видео, отложенная работа ждёт
        drive(root, target, DRIVE_MS);
      });
    }
  }, [focus, messages]);
  // полоса гаснет сама; таймер — свой: сброс focus выше перезапускает эффект перехода и снял бы его
  useEffect(() => {
    if (!flashKey) return;
    const t = setTimeout(() => setFlashKey(null), 1600);
    return () => clearTimeout(t);
  }, [flashKey]);

  // клик по цитате — к исходному сообщению; по моноширинному фрагменту (код входа) — копировать его.
  // Делегирование: один обработчик на ленту, а не на каждый бабл
  // режим выбора: клик по строке отмечает её (у альбома — все фото); ловим на погружении — ссылки, фото
  // и кнопки внутри пузыря не срабатывают
  // ключи строки для выбора: у альбома — все его фото
  const rowKeys = (m: Item) => (m.groupId ? messages.filter((x) => x.groupId === m.groupId && x.senderId === m.senderId) : [m]).map((x) => x.key as string);
  const selectable = (m: Item | undefined) => !!m && m.id != null && !m.deleted && !m.service;
  // протягивание в режиме выбора (как в Telegram): зажали на сообщении и ведём — отмечается весь диапазон
  // от первого до текущего; начали с отмеченного — диапазон снимается. У края ленты — автопрокрутка.
  const drag = useRef<{ start: number; add: boolean; base: string[]; moved: boolean; x: number; y: number; scroll: number } | null>(null);
  const dragged = useRef(false);
  const onSelectDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const row = (e.target as Element).closest<HTMLElement>('.app-msg');
    const start = row ? messages.findIndex((x) => x.key === row.dataset.key) : -1;
    if (start < 0 || !selectable(messages[start])) return;
    e.preventDefault();   // не выделять текст
    const base = getGlobal().selecting?.keys ?? [];
    drag.current = { start, add: !rowKeys(messages[start]).every((k) => base.includes(k)), base, moved: false, x: e.clientX, y: e.clientY, scroll: 0 };
    const at = (y: number) => {
      const feed = el.current!, r = feed.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(r.top + 1, Math.min(r.bottom - 1, y)))?.closest<HTMLElement>('.app-msg');
      return hit ? messages.findIndex((x) => x.key === hit.dataset.key) : -1;
    };
    const apply = (y: number) => {
      const d = drag.current; if (!d) return;
      const i = at(y); if (i < 0) return;
      const [a, b] = d.start <= i ? [d.start, i] : [i, d.start];
      const range = new Set(messages.slice(a, b + 1).filter(selectable).flatMap(rowKeys));
      const keys = d.add ? [...new Set([...d.base, ...range])] : d.base.filter((k) => !range.has(k));
      setGlobal({ selecting: { chatId, keys } });
    };
    const tick = () => {
      const d = drag.current; if (!d || !d.moved) return;
      const feed = el.current!, r = feed.getBoundingClientRect(), edge = 48;
      const v = d.y < r.top + edge ? -Math.ceil((r.top + edge - d.y) / 4) : d.y > r.bottom - edge ? Math.ceil((d.y - (r.bottom - edge)) / 4) : 0;
      if (v) { feed.scrollTop += v; apply(d.y); }
      d.scroll = requestAnimationFrame(tick);
    };
    const startY = e.clientY;
    const move = (ev: PointerEvent) => {
      const d = drag.current; if (!d) return;
      d.y = ev.clientY;
      if (!d.moved) {
        if (Math.hypot(ev.clientX - d.x, ev.clientY - startY) < 5) return;   // дрожание при клике — ещё не протягивание
        d.moved = true;
        d.scroll = requestAnimationFrame(tick);
      }
      apply(ev.clientY);
    };
    const up = () => {
      const d = drag.current;
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      drag.current = null;
      if (!d) return;
      cancelAnimationFrame(d.scroll);
      if (d.moved) {
        dragged.current = true;   // следом придёт click — он не должен переключить строку ещё раз
        setTimeout(() => { dragged.current = false; }, 0);
        if (!getGlobal().selecting?.keys.length) setGlobal({ selecting: null });   // сняли всё — выход, как при кликах
      }
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  };
  const onSelectClick = (e: MouseEvent) => {
    if (dragged.current) { e.preventDefault(); e.stopPropagation(); dragged.current = false; return; }
    const row = (e.target as Element).closest<HTMLElement>('.app-msg');
    const m = row ? messages.find((x) => x.key === row.dataset.key) : undefined;
    if (!m) return;
    e.preventDefault(); e.stopPropagation();
    // фото альбома — отмечается по отдельности (как в Telegram); кружок слева и подпись — весь альбом
    const cell = (e.target as Element).closest<HTMLElement>('.rl-media-mosaic [data-mkey], .rl-media-album [data-mkey]');
    if (cell?.dataset.mkey) { toggleSelect(chatId, [cell.dataset.mkey]); return; }
    if (m.id == null || m.deleted || m.service) return;
    toggleSelect(chatId, (m.groupId ? messages.filter((x) => x.groupId === m.groupId && x.senderId === m.senderId) : [m]).map((x) => x.key as string));
  };
  const onClick = (e: MouseEvent) => {
    if (copyCode(e)) return;
    const quote = (e.target as Element).closest('.rl-quote');
    const row = quote?.closest<HTMLElement>('.app-msg');
    if (!row) return;
    const m = messages.find((x) => x.key === row.dataset.key);
    const r = m?.reply as Quote | null | undefined;
    if (r) focusMessage({ id: r.id, sort: r.sort });
  };

  // моноширинный фрагмент (не блок кода): клик копирует. Ссылку и скрытый спойлер не перехватываем —
  // у них свой клик (переход, раскрытие); выделение текста мышью — тоже не клик по коду
  const copyCode = (e: MouseEvent): boolean => {
    const t = e.target as Element;
    const code = t.closest('.rl-bubble code.rl-code');
    if (!code || e.defaultPrevented || t.closest('a') || t.closest('.rl-spoiler:not(.rl-spoiler-open)')) return false;
    if (getSelection()?.toString()) return false;
    navigator.clipboard?.writeText(code.textContent ?? '').then(() => showToast('Код скопирован')).catch(() => { /* буфер недоступен */ });
    return true;
  };

  // реакция под баблом: своя — снять, чужая — поставить такую же
  const onReact = useRef((m: Item, emoji: string) => {
    if (m.id == null) return;
    // превью канала: реакции только для чтения (как в Telegram — сначала подписка)
    if (findChat(getGlobal(), chatId)?.preview) { showToast('Подпишитесь на канал, чтобы ставить реакции'); return; }
    // пост: своя реакция — myReaction (списка реакторов нет)
    const mine = m.reactionCounts ? (m.myReaction as string | undefined) : ((m.reactions as { userId: number; emoji: string }[] | undefined) ?? []).find((r) => r.userId === meId)?.emoji;
    react(chatId, m.id as number, mine === emoji ? null : emoji);
  }).current;

  // просмотрщик: все фото текущего окна ленты
  const photos = messages.filter((m) => !m.deleted && ['photo', 'video'].includes((m.attachment as Att | null)?.kind ?? '') && (m.attachment as Att).w);
  const openIndex = viewer === null ? null : viewer < 0 ? -1 - viewer : viewer;
  // миниатюра k-го фото в ленте: из неё вьювер вылетает и в неё же возвращается (нет в окне — просто тает)
  const photoKeys = photos.map((m) => m.key);
  // авторы фото — во вьювере всегда имя отправителя; подгружаем заранее, пока вьювер закрыт
  const authorIds = [...new Set(photos.map((m) => m.senderId as number))].join(',');
  useEffect(() => { if (authorIds) wantPeople(authorIds.split(',').map(Number)); }, [authorIds]);
  // открыли видео — тихо докачиваем его целиком на устройство: второй просмотр без сети и без ожидания
  const openAtt = openIndex !== null ? photos[openIndex]?.attachment as Att | undefined : undefined;
  useEffect(() => {
    if (openAtt?.kind === 'video' && openAtt.id) keepOffline({ id: openAtt.id, name: openAtt.name, mime: openAtt.mime, size: openAtt.size }, getPrefs().media.maxMb);
  }, [openAtt?.id]);
  // уже на устройстве — играем оттуда (мгновенно, без сети, с перемоткой), без выбора качества. Решаем в момент
  // открытия: докачалось во время просмотра — не переключаем (видео началось бы заново)
  useEffect(() => { void warmCached(); }, []);
  const offlineId = useMemo(() => (openAtt?.kind === 'video' && openAtt.id && isCached(openAtt.id) ? openAtt.id : undefined), [openAtt?.id]);
  const openOffline = useOfflineUrl(offlineId);
  const keysRef = useRef(photoKeys); keysRef.current = photoKeys;
  // ключи — из ref: колбэк стабилен (строки мемоизированы), а список фото растёт с новыми сообщениями
  const onOpen = useRef((m: Item) => { const k = keysRef.current.indexOf(m.key); if (k >= 0) setViewer(-1 - k); }).current;
  const originOf = useRef((k: number) => {
    const key = keysRef.current[k];
    // плитка альбома помечена ключом своего сообщения (data-mkey), одиночное фото — ключом строки
    return key ? el.current?.querySelector<HTMLElement>(`[data-mkey="${CSS.escape(key)}"], [data-key="${CSS.escape(key)}"] .rl-media-cell`) ?? null : null;
  }).current;

  const authorRef = useRef(onAuthor); authorRef.current = onAuthor;
  const onAuthorRow = useRef((m: Item) => authorRef.current(m.senderId as number)).current;
  const onUserRow = useRef((userId: number) => authorRef.current(userId)).current;
  const selecting = useGlobal((s) => (s.selecting?.chatId === chatId ? s.selecting.keys : null));
  // режим выбора, как в Telegram: входящие плавно сдвигаются вправо (transform, без перестройки), кружки проявляются;
  // при выходе — всё обратно, поэтому кружки и отметки живут ещё 220 мс. selOn — второй кадр: переход с места, а не скачок
  const lastSel = useRef<string[] | null>(null);
  if (selecting) lastSel.current = selecting;
  const [selVis, setSelVis] = useState(!!selecting);
  const [selOn, setSelOn] = useState(!!selecting);
  useEffect(() => {
    if (selecting) {
      setSelVis(true);
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setSelOn(true)));
      return () => cancelAnimationFrame(r);
    }
    setSelOn(false);
    const t = setTimeout(() => { setSelVis(false); lastSel.current = null; }, 220);
    return () => clearTimeout(t);
  }, [!!selecting]);
  const selShown = selecting ?? (selVis ? lastSel.current : null);
  const me = useGlobal((s) => s.me);
  const pinnedIds = useGlobal((s) => (findChat(s, chatId)?.pinned as number[] | undefined) ?? NO_IDS);
  const threadHead = useGlobal((s) => frameByKey(s, frameKey)?.thread ?? null);
  // имя канала для копии поста в группе обсуждения: связанный канал в списке — его название, иначе просто «Канал»
  // (строкой, а не списком чатов: лента не перерисовывается от каждой перемены в списке)
  const linkedTitle = useGlobal((s) => {
    // тред гостя: строки группы нет — канал из guest
    const l = (findChat(s, chatId)?.group as { linkedChatId?: number | null } | undefined)?.linkedChatId ?? frameByKey(s, frameKey)?.thread?.guest?.channelId;
    return l != null ? (s.chats.find((x) => x.id === l)?.title as string | undefined) ?? null : null;
  });
  const channelName = (_m: Item) => linkedTitle || 'Канал';
  // канал с группой обсуждения: её id — заглушке кнопки комментариев (пока копия поста не пришла)
  const discussion = useGlobal((s) => (channel && threadId == null ? (findChat(s, chatId)?.group as { linkedChatId?: number | null } | undefined)?.linkedChatId ?? null : null));
  const mentions = useGlobal((s) => (threadId == null ? (findChat(s, chatId)?.mentions as number | undefined) ?? 0 : 0));
  // «к упоминанию»: старейшее непрочитанное — в ленте (focusMessage) или в треде (тред поверх)
  const toMention = () => {
    void nextMention(chatId).then((t) => {
      if (!t) { toLatest(); return; }   // id ещё не пришли журналом — хотя бы к новым
      const target = { id: t.id, sort: t.id };
      if (t.threadId != null) openInner({ chatId, threadId: t.threadId }, target); else focusMessage(target);
    });
  };
  const nameOf = (id: number) => (id === meId ? me?.name ?? '' : people[id]?.name ?? peerName);
  const nameRef = useRef(nameOf); nameRef.current = nameOf;
  const msgsRef = useRef<Item[]>([]);
  msgsRef.current = messages;
  // круглая стрелка у пузыря: альбом — целиком
  const onQuickForward = useRef((m: Item) => {
    const all = msgsRef.current;
    startForward(chatId, m.groupId ? all.filter((x) => x.groupId === m.groupId && x.senderId === m.senderId) : [m], nameRef.current);
  }).current;
  useEffect(() => { if (group) wantPeople(messages.filter((m) => m.senderId !== meId).map((m) => m.senderId as number)); }, [group, messages]);

  // контекстное меню — одно на ленту, а не на каждый бабл (иначе обработчик ломал бы мемоизацию строк)
  const onContextMenu = (e: MouseEvent) => {
    const row = (e.target as Element).closest<HTMLElement>('.app-msg');
    if (!row) return;
    e.preventDefault();
    // что было под курсором и выделено — запоминаем сейчас: при открытии меню выделение может сброситься
    const link = (e.target as Element).closest<HTMLAnchorElement>('a[href]');
    let selection: { text: string; entities: Entity[] } | null = null;
    for (const el of row.querySelectorAll<HTMLElement>('.rl-bubble-text, .rl-media-caption')) { selection = selectionValue(el) as typeof selection; if (selection) break; }
    onMenu(row.dataset.key!, e.clientX, e.clientY, { link: link && row.contains(link) ? link.href : null, selection });
  };

  const out: unknown[] = [];
  let prevDay = '', prevSender: unknown = null, unreadShown = false;
  const isPosted = (x: Item) => isPost(x as { post?: boolean }) || (channel && !x.service);   // в канале и своё неподтверждённое — пост
  if (!partial) out.push(<div class="app-sentinel" data-dir="older" key={'o' + (messages[0]?.key ?? '')} aria-hidden="true" />);
  const shown = partial ? mergeLeaving(messages.slice(messages.length - limit!) as unknown as (Item & Msg)[], leaving.current.values() as Iterable<Item & Msg>) as Item[] : rendered;
  // соседи для хвостов, дат и пачек — без уходящих строк: раскладка соседей устоялась в кадре FLIP, не при сбросе буфера
  const isLeaving = (x: Item | undefined) => !!x && leaving.current.has(x.key as string);
  const neighbour = (i: number, dir: 1 | -1) => { let j = i + dir; while (isLeaving(shown[j])) j += dir; return shown[j]; };
  // альбомы: подряд идущие фото одного отправителя с общим groupId (до 10) — одной строкой с мозаикой
  const isPhoto = (x: Item | undefined) => !!x && !x.deleted && ['photo', 'video'].includes((x.attachment as Att | null)?.kind ?? '') && !!(x.attachment as Att).w && !!(x.attachment as Att).h;
  const albums = new Map<string, Item[]>(), inAlbum = new Set<string>();
  for (let i = 0; i < shown.length; i++) {
    const m = shown[i];
    if (!m.groupId || !isPhoto(m) || inAlbum.has(m.key)) continue;
    const run = [m];
    while (run.length < 10) { const x = shown[i + run.length]; if (!isPhoto(x) || x.groupId !== m.groupId || x.senderId !== m.senderId) break; run.push(x); }
    if (run.length > 1) { albums.set(m.key, run); run.slice(1).forEach((x) => inAlbum.add(x.key)); }
  }
  // в группе входящие одного автора — «пачка» в общей обёртке: аватар автора внизу пачки липкий (sticky), как в Telegram —
  // при прокрутке длинной пачки он держится у низа экрана и уезжает вместе с её началом
  let run: preact.VNode[] | null = null, runKey = '', runSender = 0;
  const flushRun = () => {
    if (!run) return;
    const sid = runSender, who = people[sid]?.name ?? '';
    out.push(
      <div class="app-run" key={'run' + runKey}>
        {run}
        <div class="app-run-col">
          <button type="button" class="app-run-ava" aria-label={who || 'Автор'} tabIndex={-1} onClick={(e) => { e.stopPropagation(); onUserRow(sid); }}>
            <Avatar name={who} tone={peerTone(sid)} size={34} {...senderAvatar(sid)} />
          </button>
        </div>
      </div>,
    );
    run = null;
  };
  // тред: под шапкой (копией поста) — начало обсуждения; комментариев нет — так и сказать (после загрузки, без мигания)
  const threadStart = () => {
    const empty = shown.length === 1 && threadHead!.loaded && !meta?.hasOlder;
    out.push(<div class="rl-action app-thread-start" key="thread-start" role="separator"><span>{empty ? 'Здесь пока нет комментариев' : 'Начало обсуждения'}</span></div>);
    prevSender = null;
  };
  let joinedShown = false;
  const joinedLine = () => { joinedShown = true; flushRun(); out.push(<div class="rl-action app-joined" key="joined" role="note"><span>Вы подписались на канал</span></div>); };
  shown.forEach((m, i) => {
    if (inAlbum.has(m.key)) return;   // уже нарисовано в альбоме выше
    // удалённых в ленте нет (как в Telegram); остаётся только шапка треда удалённого поста — без пузыря: «Пост удалён»
    // написано на плашке над тредом (ThreadBar)
    if (m.deleted) { if (threadId != null && m.key === threadHead?.header) { flushRun(); threadStart(); } return; }
    if (joinedAfter != null && !joinedShown && typeof m.id === 'number' && m.id > joinedAfter) { joinedLine(); prevSender = null; }
    const day = dayKey(m.createdAt as string);
    const post = isPosted(m);
    // пост никогда не «исходящий»: слева, без хвоста отправителя (даже свой)
    const mine = !post && m.senderId === meId;
    const going = isLeaving(m);   // уходящая: рисуется на месте, но дату, пачку и группу соседей не меняет
    if (!going && day !== prevDay) flushRun();
    if (!going && day !== prevDay) { const at = m.createdAt as string; out.push(<DateDivider key={'d' + day} onClick={() => setPickDate(new Date(at))}>{dayLabel(at)}</DateDivider>); }
    if (!going && !unreadShown && unreadFrom != null && !mine && m.id != null && (m.id as number) > unreadFrom) {
      unreadShown = true;
      flushRun();
      out.push(<div class="app-unread-divider" key="unread" role="separator"><span>Непрочитанные сообщения</span></div>);
    }
    // служебные события группы — плашкой по центру, как в Telegram (не пузырём)
    const svc = m.service as { type?: string; data?: ServiceData } | undefined;
    // чек-лист: «X отметил(а) «задача» как выполненную» / «добавил(а) задачу» — плашкой, названия — из самого списка
    if (svc?.type === 'todo_done' || svc?.type === 'todo_append') {
      flushRun();
      const list = messages.find((x) => x.id === m.replyToId)?.todo as { title: string; items: { id: number; title: string }[] } | undefined;
      out.push(<div class="rl-action" key={m.key} role="note"><span>{todoLine(svc.type, svc.data ?? {}, mine ? 'Вы' : people[m.senderId as number]?.name ?? peerName, list)}</span></div>);
      prevDay = day; prevSender = null;
      return;
    }
    if (isGroupService(svc?.type)) {
      const text = serviceText(svc!.type as ServiceType, { data: svc!.data, body: m.body as string, mine, sender: people[m.senderId as number]?.name ?? peerName, meId, fromChannel: post || m.senderId === 0 });
      flushRun();
      out.push(<div class="rl-action" key={m.key} role="note"><span>{text}</span></div>);
      prevDay = day; prevSender = null;
      return;
    }
    const album = albums.get(m.key);
    const next = going ? shown[i + 1] : neighbour(i + (album ? album.length : 1) - 1, 1);
    // группа — как в Telegram: тот же отправитель и день, пауза не больше 10 минут, не на границе «Непрочитанные»
    // посты (и копии постов в группе) — пачкой «канала»: отправитель для пачки — 0
    const sender = post ? 0 : m.senderId;
    const nextSender = next ? (isPosted(next) ? 0 : next.senderId) : null;
    // пост канала — всегда отдельный пузырь с хвостиком (как в Telegram: посты в пачку не склеиваются)
    const prevM = going ? shown[i - 1] : neighbour(i, -1);   // уходящая держит свои прежние хвосты: соседи для неё — как были
    const start = post || prevSender !== sender || day !== prevDay || breaksGroup(prevM, m, unreadFrom, meId);
    const end = post || !next || nextSender !== sender || dayKey(next.createdAt as string) !== day || breaksGroup(m, next, unreadFrom, meId);
    const quoted = m.reply as Quote | null;
    // файлы, отправленные вместе (groupId), — одним пузырём: позиция строки внутри группы
    const same = (x: Item | undefined) => !!x && !!m.groupId && x.groupId === m.groupId && x.senderId === m.senderId && !x.deleted;
    const pos = !m.groupId || m.deleted ? 'single' : same(prevM) && same(next) ? 'middle' : same(prevM) ? 'last' : same(next) ? 'first' : 'single';
    const row = (
      <Row
        pos={pos}
        key={m.key}
        post={post}
        discussion={post ? discussion : null}
        pinned={post && m.id != null && pinnedIds.includes(m.id as number)}
        // копия поста в группе (и шапка треда) подписана каналом; в самом канале автора нет
        author={post ? (!channel && start && !m.deleted ? channelName(m) : undefined) : group && !mine && start && !m.deleted ? people[m.senderId as number]?.name ?? '' : undefined}
        onAuthor={onAuthorRow}
        onUser={onUserRow}
        sel={selShown ? (album ?? [m]).every((x) => selShown.includes(x.key as string)) : undefined}
        selIn={selShown && album ? album.filter((x) => selShown.includes(x.key as string)).map((x) => x.key).join(',') : undefined}
        grp={group && !mine && !post}
        onQuickForward={onQuickForward}
        hl={highlight && (m.body as string).toLowerCase().includes(highlight.toLowerCase()) ? highlight : undefined}
        m={m}
        meId={meId}
        chatId={chatId}
        voiceTitle={mine ? 'Вы' : post ? (channel ? peerName : channelName(m)) : (group ? people[m.senderId as number]?.name ?? peerName : peerName)}
        onReact={onReact}
        onOpen={onOpen}
        out={mine}
        start={start}
        end={end}
        quoted={quoted}
        quoteAuthor={quoted && !quoted.deleted ? (quoted.senderId === meId ? 'Вы' : group ? people[quoted.senderId as number]?.name ?? '' : peerName) : undefined}
        quoteTone={quoted ? (quoted.senderId === meId ? 'accent' : peerTone(quoted.senderId as number)) : undefined}
        appear={appearAt.current.has(m.key as string)}
        flash={flashKey === m.key || !!album?.some((x) => x.key === flashKey)}
        album={album}
        leaving={going}
      />
    );
    if (going) {
      // уходящая внутри пачки остаётся в её обёртке (absolute считается от пачки), иначе — отдельной строкой
      if (run) run.push(row); else out.push(row);
      return;
    }
    if (group && !mine && !post) {
      if (run && (start || runSender !== m.senderId)) flushRun();
      if (!run) { run = []; runKey = m.key as string; runSender = m.senderId as number; }
      run.push(row);
      if (end) flushRun();
    } else {
      flushRun();
      out.push(row);
    }
    prevDay = day; prevSender = sender;
    if (threadId != null && m.key === threadHead?.header) threadStart();
  });
  flushRun();
  if (joinedAfter != null && !joinedShown && shown.length && !meta?.hasNewer) joinedLine();   // новых постов ещё нет — строка внизу
  out.push(<div class="app-sentinel" data-dir="newer" key={'n' + (messages[messages.length - 1]?.key ?? '')} aria-hidden="true" />);

  // тред ещё не загружен и в кэше пусто (открыли по адресу): лоадер с задержкой и минимумом — без мигания
  const threadLoading = useMinVisible(threadId != null && !threadHead?.loaded && !messages.length, { delay: 150, min: 600 });
  return (
    <>
      {greetReady ? <Presence show={greetShown} exitMs={GREET_FLIGHT_MS + GREET_LAND_MS + 60}><GreetingCard sticker={greetSticker} onSend={onGreet} /></Presence> : null}
      {threadId != null ? <Presence show={threadLoading} exitMs={200}><div class="app-thread-loading" role="status" aria-label="Загрузка комментариев"><span class="app-thread-spinner"><ProgressRing size={32} onMedia /></span></div></Presence> : null}
      <div class={'rl-feed' + (selVis ? ' app-feed-selecting' : '') + (selOn && selecting ? ' app-feed-sel-on' : '')} ref={el} onScroll={onScroll} onClick={onClick} onClickCapture={selecting ? onSelectClick : undefined} onPointerDownCapture={selecting ? onSelectDown : undefined} onContextMenu={onContextMenu} aria-live="polite"><LazyRoot.Provider value={lazyRoot}>{out}</LazyRoot.Provider></div>
      {openIndex !== null && photos[openIndex] ? (
        <MediaViewer
          index={openIndex}
          sender={peerName}
          items={photos.map((m) => { const a = m.attachment as Att; return { ...(isPosted(m) ? { sender: peerName, avatar: avatarPhoto(chatPhoto) } : { sender: m.senderId === meId ? 'Вы' : !group && !channel ? peerName : people[m.senderId as number]?.name ?? '', avatar: senderAvatar(m.senderId as number) }),   // личный чат: собеседника в people может не быть — его имя и так известно; в группе — не её название: пока имени нет — пусто
 src: localPreview(m.key) ?? (openOffline && a.id === openAtt?.id ? openOffline : fileUrl(a)), qualities: localPreview(m.key) || (openOffline && a.id === openAtt?.id) ? undefined : qualitiesOf(a), preview: localPreview(m.key) ? undefined : viewerPreview(a), kind: a.kind === 'video' ? 'video' : 'image', thumb: a.thumb, w: a.w, h: a.h, name: a.name, download: fileUrl(a, true), caption: m.body, date: clock(m.createdAt as string) }; })}
          origin={originOf}
          actions={(_it: unknown, i: number) => [{ icon: 'forward', label: 'Переслать', onClick: () => { const p = photos[i]; setViewer(null); if (p) startForward(chatId, [p], nameOf); } }]}
          onClose={() => setViewer(null)}
        />
      ) : null}
      {pickerUsed ? <DatePicker open={!!pickDate} value={pickDate ?? undefined} onClose={() => setPickDate(null)}
        onPick={(d: Date) => { setPickDate(null); void jumpToDate(chatId, d).then((ok) => { if (!ok) showToast('В этот день сообщений нет'); }); }} /> : null}
      <div class="rl-scrolldown-slot">
        <MentionFab count={mentions} raised={away || (meta ? !meta.live : false)} onClick={toMention} />
        <ScrollToBottom show={away || (meta ? !meta.live : false)} unread={threadId != null ? 0 : unread} onClick={toLatest} />
      </div>
    </>
  );
}

/** Текст служебной строки чек-листа (как в Telegram): одна задача — по названию, несколько — числом. */
function todoLine(type: string, d: { completed?: number[]; incompleted?: number[]; items?: number[] }, who: string, list?: { title: string; items: { id: number; title: string }[] }): string {
  const you = who === 'Вы';
  const name = (id: number) => list?.items.find((x) => x.id === id)?.title ?? 'задачу';
  const many = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'задачу' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'задачи' : 'задач'}`;
  if (type === 'todo_append') {
    const ids = d.items ?? [];
    const what = ids.length === 1 ? `задачу «${name(ids[0])}»` : many(ids.length);
    return `${who} ${you ? 'добавили' : 'добавил(а)'} ${what} в «${list?.title ?? 'чек-лист'}»`;
  }
  const done = d.completed ?? [], undone = d.incompleted ?? [];
  const part = (ids: number[], ok: boolean) => ids.length === 1
    ? `«${name(ids[0])}» как ${ok ? 'выполненную' : 'невыполненную'}`
    : `${many(ids.length)} как ${ok ? 'выполненные' : 'невыполненные'}`;
  const verb = you ? 'отметили' : 'отметил(а)';
  if (done.length && undone.length) return `${who} ${verb} ${part(done, true)} и ${part(undone, false)}`;
  return `${who} ${verb} ${done.length ? part(done, true) : part(undone, false)}`;
}
