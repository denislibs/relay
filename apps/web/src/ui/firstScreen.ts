// Первый экран ленты: сколько строк строить в первом кадре открытого чата (как в Telegram Web K) — ровно
// заполнить экран вокруг точки открытия с запасом, а остальное окно дорисовать порциями уже после показа.
// Высоты строк — оценкой по данным, без раскладки: текст — шириной строки (canvas measureText), медиа — по w/h,
// остальное — константами. Оценки нарочно занижены: лучше построить на пару строк больше, чем показать пустоту
// над первым экраном. Поправка по чату (learnScale) только сверяет оценку с настоящими высотами.

/** Поля сообщения, от которых зависит высота строки. */
export interface RowLike {
  key: string;
  id?: number | null;
  senderId?: number;
  kind?: string;
  body?: string;
  deleted?: boolean;
  service?: unknown;
  sticker?: { w?: number | null; h?: number | null } | null;
  attachment?: { kind?: string; w?: number | null; h?: number | null } | null;
  replyToId?: number | null;
  fwdFrom?: unknown;
  link?: unknown;
  reactions?: unknown[] | null;
  poll?: unknown; todo?: unknown; geo?: unknown; contact?: unknown; dice?: unknown; blocks?: unknown; buttons?: unknown;
  groupId?: string | number | null;
}

export interface Metrics {
  textW: number;       // ширина текста в пузыре, px
  lineH: number;       // высота строки текста
  pad: number;         // поля пузыря и строка времени над текстом
  gap: number;         // между строками ленты
  mediaW: number;      // наибольшая ширина медиа в пузыре
  mediaH: number;      // наибольшая высота медиа
  sticker: number;     // сторона стикера
  scale: number;       // поправка по настоящим высотам (learnScale)
  measure: (s: string) => number;   // ширина строки текста в px
}

const fit = (w: number | null | undefined, h: number | null | undefined, maxW: number, maxH: number, fallback: number): number => {
  if (!w || !h || w <= 0 || h <= 0) return fallback;
  return Math.min(maxH, (h * Math.min(maxW, w)) / w);
};

/** Строк текста: каждый абзац — не меньше одной; перенос по словам строк только добавит (оценка снизу). */
export function textLines(body: string, x: Pick<Metrics, 'textW' | 'measure'>): number {
  if (!body) return 0;
  let n = 0;
  for (const p of body.split('\n')) n += Math.max(1, Math.ceil(x.measure(p) / Math.max(1, x.textW)));
  return n;
}

/** Высота строки ленты, px (снизу). */
export function estimateRow(m: RowLike, x: Metrics): number {
  let h: number;
  if (m.deleted || m.service) h = 30;
  else if (m.sticker) h = fit(m.sticker.w, m.sticker.h, x.sticker, x.sticker, x.sticker * 0.6);
  else if (m.attachment) {
    const k = m.attachment.kind;
    if (k === 'photo' || k === 'video') h = fit(m.attachment.w, m.attachment.h, x.mediaW, x.mediaH, 120);
    else if (k === 'round') h = 200;
    else h = 52;   // голосовое, музыка, файл
    if (m.body) h += textLines(m.body, x) * x.lineH + 8;
  } else if (m.poll || m.todo) h = 120;
  else if (m.geo) h = 150;
  else if (m.blocks) h = 150;
  else if (m.dice) h = 100;
  else if (m.contact) h = 64;
  else h = x.pad + Math.max(1, textLines(m.body ?? '', x)) * x.lineH;
  if (!m.deleted && !m.service) {
    if (m.replyToId != null) h += 40;
    if (m.fwdFrom) h += 20;
    if (m.link) h += 60;
    if (m.buttons) h += 40;
    if (m.reactions && m.reactions.length) h += 26;
  }
  return (h + x.gap) * x.scale;
}

/** Не резать альбом: край окна сдвигается так, чтобы подряд идущие строки одного groupId были целиком внутри. */
export function albumSafe(list: readonly RowLike[], from: number, to: number): [number, number] {
  const same = (a: RowLike | undefined, b: RowLike | undefined) => !!a && !!b && a.groupId != null && a.groupId === b.groupId && a.senderId === b.senderId;
  while (from > 0 && same(list[from - 1], list[from])) from--;
  while (to < list.length - 1 && same(list[to], list[to + 1])) to++;
  return [from, to];
}

export type OpenAt =
  | { mode: 'bottom' }
  | { mode: 'anchor'; index: number; above: number };   // строка index встанет на высоте above от верха видимой ленты

export interface View { height: number; margin: number }

/**
 * Окно первого кадра [from, to] (включительно) или null — строить всё (окно и так почти целиком нужно).
 * Низ: с конца вверх, пока не наберётся экран + запас. Якорь (непрочитанное, сохранённая позиция, переход):
 * над якорем — его отступ + запас, от якоря вниз — остаток экрана + запас.
 */
export function firstWindow(list: readonly RowLike[], at: OpenAt, view: View, x: Metrics): [number, number] | null {
  const n = list.length;
  if (n === 0) return null;
  let from: number, to: number;
  if (at.mode === 'bottom') {
    to = n - 1;
    let sum = 0;
    from = n;
    while (from > 0 && sum < view.height + view.margin) sum += estimateRow(list[--from], x);
  } else {
    const a = Math.max(0, Math.min(n - 1, at.index));
    let up = 0, down = 0;
    from = a; to = a;
    while (from > 0 && up < Math.max(0, at.above) + view.margin) up += estimateRow(list[--from], x);
    down = estimateRow(list[a], x);
    while (to < n - 1 && down < Math.max(0, view.height - at.above) + view.margin) down += estimateRow(list[++to], x);
  }
  [from, to] = albumSafe(list, from, to);
  // почти всё окно — строить сразу целиком: дорисовка ради пары строк дороже, чем они сами
  if (to - from + 1 >= n * 0.8 || n - (to - from + 1) < 6) return null;
  return [from, to];
}

/**
 * Следующий шаг дорисовки: сначала вниз (ниже экрана — ничего не сдвигается), потом вверх; null — окно полное.
 */
export function extendWindow(list: readonly RowLike[], win: [number, number], chunk: number): [number, number] | null {
  let [from, to] = win;
  const last = list.length - 1;
  if (to < last) to = Math.min(last, to + chunk);
  else if (from > 0) from = Math.max(0, from - chunk);
  else return null;
  [from, to] = albumSafe(list, from, to);
  return from <= 0 && to >= last ? null : [from, to];
}

/**
 * Поправка оценок по настоящим высотам строк: наименьшее отношение «реально / оценка», чтобы оценка осталась
 * оценкой снизу и для самых низких строк. Пределы — от случайных выбросов (строка ещё грузит медиа).
 */
export function learnScale(samples: readonly { actual: number; estimate: number }[], prev: number): number {
  const r = samples.filter((s) => s.actual > 0 && s.estimate > 0).map((s) => s.actual / (s.estimate / prev)).sort((x, y) => x - y);
  if (r.length < 3) return prev;
  // 10-й процентиль, а не минимум: одна строка с ещё не догруженным медиа не должна раздувать первый экран
  return Math.max(0.8, Math.min(2, r[Math.floor((r.length - 1) * 0.1)]));
}
