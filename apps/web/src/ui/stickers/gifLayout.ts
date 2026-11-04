// Раскладка плиток вкладки GIF: ряды одной высоты на всю ширину (мозаика, как в панели Telegram). Чистый расчёт из
// размеров вложений: всё известно до загрузки, плитки не прыгают, а DOM можно держать только для окна прокрутки.
export interface GifSize { id: string; w: number | null; h: number | null }
export interface GifBox { id: string; x: number; y: number; w: number; h: number }
export interface GifLayout { boxes: GifBox[]; height: number }

export const GIF_GAP = 3;
const ROW_H = 104;                     // желаемая высота ряда
const MIN_RATIO = 0.6, MAX_RATIO = 2.2;   // очень узкие и очень широкие не ломают ряд: обрезаются (object-fit: cover)

const ratioOf = (g: GifSize) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, g.w && g.h ? g.w / g.h : 1));

/** Плитки по порядку: ряд набирается, пока при желаемой высоте он не заполнит ширину; затем высота подгоняется точно под неё. */
export function gifLayout(items: GifSize[], width: number): GifLayout {
  const boxes: GifBox[] = [];
  if (width <= 0) return { boxes, height: 0 };
  let y = 0, row: { g: GifSize; r: number }[] = [], sum = 0;
  const flush = (full: boolean) => {
    if (!row.length) return;
    const free = width - GIF_GAP * (row.length - 1);
    const h = full ? Math.round(free / sum) : ROW_H;   // неполный последний ряд не растягивается
    let x = 0;
    row.forEach((t, i) => {
      // последняя плитка полного ряда — до края: округления не оставляют зазор справа
      const w = full && i === row.length - 1 ? width - x : Math.round(t.r * h);
      boxes.push({ id: t.g.id, x, y, w, h });
      x += w + GIF_GAP;
    });
    y += h + GIF_GAP;
    row = []; sum = 0;
  };
  for (const g of items) {
    const r = ratioOf(g);
    row.push({ g, r });
    sum += r;
    if (sum * ROW_H + GIF_GAP * (row.length - 1) >= width) flush(true);
  }
  flush(false);
  return { boxes, height: Math.max(0, y - GIF_GAP) };
}

/** Какие плитки держать в DOM: [from, to) пересекают полосу top…bottom с запасом. Плитки идут сверху вниз. */
export function gifWindow(boxes: GifBox[], top: number, bottom: number, margin: number): [number, number] {
  const hi = bottom + margin, lo = top - margin;
  let from = 0;
  while (from < boxes.length && boxes[from].y + boxes[from].h < lo) from++;
  let to = from;
  while (to < boxes.length && boxes[to].y <= hi) to++;
  return [from, to];
}
