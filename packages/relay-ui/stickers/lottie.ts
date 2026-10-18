// Мини-конструктор Lottie: слои-фигуры, ключевые кадры с easing, группы. Стикеры Relay пишутся
// кодом (stickers/*.ts) и при сборке превращаются в .tgs (gzip JSON) — свои, не из Telegram.

export type V = number | number[];
type Ease = { o: [number, number]; i: [number, number] };
export type Key = [frame: number, value: V, ease?: Ease];

/** Кривые: стандартная, «выход» (быстро → плавно), с отскоком (перелёт делается значением кадра). */
export const ease = {
  std: { o: [0.4, 0], i: [0.2, 1] } as Ease,
  out: { o: [0.16, 1], i: [0.3, 1] } as Ease,
  inOut: { o: [0.65, 0], i: [0.35, 1] } as Ease,
  lin: { o: [0, 0], i: [1, 1] } as Ease,
};

const arr = (v: V) => (Array.isArray(v) ? v : [v]);

/** Свойство: число/вектор или ключевые кадры. */
export function prop(v: V | Key[]): object {
  if (!Array.isArray(v) || !Array.isArray(v[0])) return { a: 0, k: v };
  const keys = v as Key[];
  return {
    a: 1,
    k: keys.map(([t, val, e], n) => {
      const dims = arr(val).length;
      const ez = e ?? ease.std;
      return n === keys.length - 1
        ? { t, s: arr(val) }
        : { t, s: arr(val), o: { x: Array(dims).fill(ez.o[0]), y: Array(dims).fill(ez.o[1]) }, i: { x: Array(dims).fill(ez.i[0]), y: Array(dims).fill(ez.i[1]) } };
    }),
  };
}

export const hex = (c: string, a = 1) => {
  const n = parseInt(c.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
};

type Tr = { p?: V | Key[]; a?: V | Key[]; s?: V | Key[]; r?: V | Key[]; o?: V | Key[] };
const tr = (t: Tr = {}) => ({ ty: 'tr', p: prop(t.p ?? [0, 0]), a: prop(t.a ?? [0, 0]), s: prop(t.s ?? [100, 100]), r: prop(t.r ?? 0), o: prop(t.o ?? 100), sk: prop(0), sa: prop(0) });

export const rect = (w: V | Key[], hgt: number | null, r: number | Key[], p: V | Key[] = [0, 0]) =>
  ({ ty: 'rc', d: 1, s: prop(hgt == null ? (w as V | Key[]) : [w as number, hgt]), p: prop(p), r: prop(r) });
export const ellipse = (d: number | Key[], p: V | Key[] = [0, 0]) =>
  ({ ty: 'el', d: 1, s: prop(Array.isArray(d) ? (d as Key[]).map(([t, v, e]) => [t, [v as number, v as number], e] as Key) : [d, d]), p: prop(p) });
/** Замкнутый контур по точкам (острые углы). */
export const poly = (pts: [number, number][]) =>
  ({ ty: 'sh', ks: prop({ c: true, v: pts, i: pts.map(() => [0, 0]), o: pts.map(() => [0, 0]) } as unknown as V) });
/** Заливка; evenodd — внутренние контуры группы вырезаются (кольцо = два круга). */
export const fill = (c: string, o: V | Key[] = 100, evenodd = false) => ({ ty: 'fl', c: prop(hex(c)), o: prop(o), r: evenodd ? 2 : 1 });
export const stroke = (c: string, w: number, o: V | Key[] = 100) => ({ ty: 'st', c: prop(hex(c)), o: prop(o), w: prop(w), lc: 2, lj: 2 });
export const trim = (s: V | Key[], e: V | Key[]) => ({ ty: 'tm', s: prop(s), e: prop(e), o: prop(0), m: 1 });
export const group = (items: object[], t: Tr = {}, nm = 'g') => ({ ty: 'gr', nm, it: [...items, tr(t)] });

let ind = 0;
/** Слой-фигура: transform слоя + группы. ip/op — когда виден. */
export function layer(nm: string, shapes: object[], t: Tr = {}, opts: { ip?: number; op?: number; parent?: number } = {}) {
  ind += 1;
  return {
    ddd: 0, ind, ty: 4, nm, sr: 1, ao: 0, bm: 0, st: 0,
    ip: opts.ip ?? 0, op: opts.op ?? 9999,
    ...(opts.parent ? { parent: opts.parent } : {}),
    ks: { o: prop(t.o ?? 100), r: prop(t.r ?? 0), p: prop(t.p ?? [256, 256, 0]), a: prop(t.a ?? [0, 0, 0]), s: prop(t.s ?? [100, 100, 100]) },
    shapes,
  };
}

/** Документ: слои перечисляются сверху вниз (первый — поверх всех). */
export function doc(nm: string, frames: number, layers: object[], fps = 60, size = 512) {
  const op = frames;
  for (const l of layers as { op: number }[]) if (l.op > op) l.op = op;
  ind = 0;
  return { v: '5.7.4', fr: fps, ip: 0, op, w: size, h: size, nm, ddd: 0, assets: [], layers };
}

/** Пустой слой-родитель: общий transform для группы слоёв (например, «всплытие» всего стикера). */
export function nul(nm: string, t: Tr = {}) {
  ind += 1;
  return {
    ddd: 0, ind, ty: 3, nm, sr: 1, ao: 0, bm: 0, st: 0, ip: 0, op: 9999,
    ks: { o: prop(100), r: prop(t.r ?? 0), p: prop(t.p ?? [256, 256, 0]), a: prop(t.a ?? [256, 256, 0]), s: prop(t.s ?? [100, 100, 100]) },
  };
}
