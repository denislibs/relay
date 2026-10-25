// Чистые расчёты для вкладок «Общих медиа» (ui/SharedMedia.tsx): названия вкладок, какой адрес грузит плитка.
import type { MediaTab } from '@relay/protocol';

type Variant = { name: string; w: number; h: number; size: number };
export type TileAtt = { id: string; kind: string; mime: string; preview?: Omit<Variant, 'name'> & { name?: string } | null };   // у снимка в ленте имени копии нет

/** Плитка фото: маленькая копия сервера (jobs/photo.ts, до 480 px), пока её нет — оригинал. */
export const tileSrc = (a: TileAtt): string => (a.preview ? `/files/${a.id}/preview` : `/files/${a.id}`);

/** Длинная сторона копии medium на сервере (jobs/photo.ts PHOTO_MEDIUM_SIDE). */
export const BUBBLE_SIDE = 800;
export type BubbleAtt = TileAtt & { w?: number | null; h?: number | null; variants?: Variant[] };
/** Фото в пузыре ленты (как в Telegram — средний размер, не оригинал): копия medium (до 800 px); её ещё нет
 *  (фото до дозаполнения, backfillPhotos.ts) — превью до 480 px, но только у большого оригинала: оригинал до 800 px
 *  сам размером с medium и резче превью. Видео и всё прочее — оригинал. Оригинал фото — для просмотрщика. */
export const bubbleSrc = (a: BubbleAtt): string => {
  if (a.kind !== 'photo') return `/files/${a.id}`;
  if (a.variants?.some((v) => v.name === 'medium')) return `/files/${a.id}/medium`;
  if (a.preview && Math.max(a.w ?? 0, a.h ?? 0) > BUBBLE_SIDE) return `/files/${a.id}/preview`;
  return `/files/${a.id}`;
};

/** Первый слой просмотрщика: то, что уже показано в пузыре (bubbleSrc), — из кэша браузера сразу и резко, пока
 *  грузится оригинал. Только фото и только если пузырь показывает не сам оригинал. */
export const viewerPreview = (a: BubbleAtt): string | undefined => {
  if (a.kind !== 'photo' || !a.id) return undefined;
  const s = bubbleSrc(a);
  return s === `/files/${a.id}` ? undefined : s;
};

/** Кадр видео без миниатюры: короткий немой ролик сервера (jobs/video.ts, 360p), пока его нет — оригинал;
 *  #t=0.1 — не чёрный самый первый кадр. */
export const videoFrameSrc = (a: TileAtt): string => (a.preview ? `/files/${a.id}/preview` : `/files/${a.id}`) + '#t=0.1';

export type SharedTab = MediaTab | 'members' | 'groups';
export const TAB_LABEL: Record<SharedTab, string> = { members: 'Участники', media: 'Медиа', file: 'Файлы', link: 'Ссылки', audio: 'Музыка', voice: 'Голосовые', groups: 'Группы' };
/** Название вкладки: на самой вкладке и в шапке панели, когда вкладки прилипли к верху (как в Telegram). */
export const tabLabel = (t: SharedTab): string => TAB_LABEL[t];

const ru = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many}`;
};
/** Счётчик вкладки для шапки (как в Telegram: «271 фото, 36 видео», «8 файлов»…); null — ещё неизвестен.
 *  media: фото и видео раздельно, если сервер прислал video; нулевая часть не пишется. */
export function tabCounter(t: SharedTab, counts: (Partial<Record<MediaTab, number>> & { video?: number }) | null, members?: number | null, groups?: number | null): string | null {
  if (t === 'members') return members == null ? null : ru(members, 'участник', 'участника', 'участников');
  if (t === 'groups') return groups == null ? null : ru(groups, 'общая группа', 'общие группы', 'общих групп');
  const n = counts?.[t];
  if (n == null) return null;
  switch (t) {
    case 'media': {
      if (counts!.video == null) return ru(n, 'медиафайл', 'медиафайла', 'медиафайлов');
      const video = counts!.video, photo = Math.max(0, n - video);
      const parts = [photo ? `${photo} фото` : '', video ? `${video} видео` : ''].filter(Boolean);
      return parts.length ? parts.join(', ') : '0 фото';
    }
    case 'file': return ru(n, 'файл', 'файла', 'файлов');
    case 'link': return ru(n, 'ссылка', 'ссылки', 'ссылок');
    case 'audio': return ru(n, 'аудиофайл', 'аудиофайла', 'аудиофайлов');
    case 'voice': return ru(n, 'голосовое сообщение', 'голосовых сообщения', 'голосовых сообщений');
  }
  return null;
}

/** Клик по вкладке, пока над ней ещё виден профиль: куда прокрутить панель, чтобы вкладки доехали до верха.
 *  offset — расстояние от верха области прокрутки до вкладок, max — предел прокрутки. null — уже прилипли, ехать некуда. */
export function tabScrollTarget(p: { scrollTop: number; offset: number; max: number }): number | null {
  if (p.offset <= 1) return null;
  const to = Math.min(p.scrollTop + p.offset, p.max);
  return to - p.scrollTop > 1 ? to : null;
}

/** Положение прокрутки в момент t (мс) плавного переезда from → to за ms: мягкий разгон и торможение. */
export function scrollAt(from: number, to: number, ms: number, t: number): number {
  if (t >= ms) return to;
  const x = Math.max(0, t / ms);
  const k = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  return from + (to - from) * k;
}

/** Плавная прокрутка el до top за ms (нативная smooth не задаёт длительность). Без анимации — сразу.
 *  Колесо, касание, нажатие или клавиша посреди пути — прокрутка отдаётся человеку, done сразу. Возвращает отмену (без done). */
export function animateScroll(el: HTMLElement, top: number, ms: number, instant: boolean, done: () => void): () => void {
  if (instant) { el.scrollTop = top; done(); return () => {}; }
  const from = el.scrollTop;
  let start = 0, raf = 0;
  const GRAB = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; for (const t of GRAB) el.removeEventListener(t, grab); };
  const finish = () => { stop(); done(); };
  function grab() { finish(); }
  const step = (now: number) => {
    if (!start) start = now;
    el.scrollTop = scrollAt(from, top, ms, now - start);
    if (now - start >= ms) { finish(); return; }
    raf = requestAnimationFrame(step);
  };
  for (const t of GRAB) el.addEventListener(t, grab, { passive: true });
  raf = requestAnimationFrame(step);
  return stop;
}

export const GRID_COLS = 3;

/** Скруглённые углы плитки i из n — только внешние углы всей сетки (как в Telegram), как это делали
 *  :nth-child у обычной CSS-сетки: tl, tr, bl, br через пробел. */
export function gridCorners(i: number, n: number): string {
  const last = i === n - 1, tail = i >= n - GRID_COLS, col = i % GRID_COLS;
  const out: string[] = [];
  if (i === 0) out.push('tl');
  if (i === GRID_COLS - 1 || (last && i < GRID_COLS - 1)) out.push('tr');
  if (col === 0 && tail) out.push('bl');
  if (last || (col === GRID_COLS - 1 && tail)) out.push('br');
  return out.join(' ');
}

/** Плашка даты над «Медиа» (как в Telegram): чью дату показывать, когда линия y (px от верха сетки, у нижнего края
 *  вкладок) — первая плитка, чей низ ниже линии; плитки одного ряда — первая в ряду. Ряды одинаковые (cell — высота
 *  плитки, step — шаг ряда с зазором), поэтому ряд считается делением, без обхода плиток. -1 — сетка пуста. */
export function gridDateIndex(y: number, cell: number, step: number, n: number, cols = GRID_COLS): number {
  if (n <= 0 || cols <= 0) return -1;
  const rows = Math.ceil(n / cols);
  // низ ряда r — r·step + cell; нужен первый r, у которого он ниже y (линия в зазоре — уже следующий ряд)
  const row = step > 0 ? Math.floor((y - cell) / step) + 1 : 0;
  return Math.min(Math.max(row, 0), rows - 1) * cols;
}
