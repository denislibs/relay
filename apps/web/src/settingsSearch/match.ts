// Поиск по настройкам: сопоставление запроса с пунктами индекса и ранжирование. Чистый модуль, без DOM.
// Поведение — как в Telegram Web K: каждое слово запроса — начало какого-то слова пункта (без опечаток),
// запрос пробуется и в другой раскладке, синонимы — на пункте.

export type EntryKind = 'section' | 'subsection' | 'row' | 'toggle' | 'option';
export interface SearchCtx { dev: boolean; hasPassword: boolean | null }

export interface Entry {
  id: string;
  /** Страница, на которой пункт (`section` — сама страница). */
  path: string;
  title: string;
  kind: EntryKind;
  /** Подраздел на той же странице (заголовок секции), в крошках встаёт после страниц. */
  parent?: string;
  keywords?: string[];
  /** Плитка раздела верхнего уровня (показывается у первой строки группы). */
  icon?: string;
  tile?: string;
  /** Пункт доступен (нет — не ищется). */
  when?: (ctx: SearchCtx) => boolean;
}

export interface Hit { entry: Entry; crumbs: string[]; score: number; hits: [number, number][] }
export interface Group { section: Entry; items: Hit[] }

/** Посимвольная свёртка: нижний регистр, ё → е, всё кроме букв и цифр — пробел. Длина и позиции — как у исходной строки. */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.toLowerCase();
    const one = c.length === ch.length ? c : ch;   // редкие буквы, у которых нижний регистр длиннее, — как есть
    out += one === 'ё' ? 'е' : /[\p{L}\p{N}]/u.test(one) ? one : ' '.repeat(one.length);
  }
  return out;
}

/** Строка для сравнения: свёртка, пробелы схлопнуты, по краям убраны. */
export const normalize = (s: string): string => fold(s.normalize('NFC')).replace(/\s+/g, ' ').trim();

const EN = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const RU = 'ёйцукенгшщзхъфывапролджэячсмитьбю';
const toRu = new Map([...EN].map((c, i) => [c, RU[i]]));
const toEn = new Map([...RU].map((c, i) => [c, EN[i]]));
const swap = (s: string, map: Map<string, string>) => [...s.toLowerCase()].map((c) => map.get(c) ?? c).join('');

/** Запрос как есть, затем набранный не в той раскладке (qwerty → йцукен, йцукен → qwerty); пустые и повторы убраны. */
export function layoutVariants(q: string): string[] {
  const out: string[] = [];
  for (const v of [q, /[a-z`[\];',.]/i.test(q) ? swap(q, toRu) : '', /[а-яё]/i.test(q) ? swap(q, toEn) : '']) {
    const n = normalize(v);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Слова строки с их началом: позиции — в исходной строке. */
function words(s: string): { w: string; at: number }[] {
  const f = fold(s), out: { w: string; at: number }[] = [];
  for (const m of f.matchAll(/\S+/g)) out.push({ w: m[0], at: m.index! });
  return out;
}

// уровни ранжирования: начало заголовка → слово внутри заголовка → с крошками → только синонимы
const TITLE_START = 0, TITLE = 1, CRUMBS = 2, KEYWORDS = 3;

const depth = (e: Entry) => e.path.split('/').length + (e.parent ? 1 : 0);
const topOf = (path: string) => path.split('/').slice(0, 2).join('/');

/** Найденные пункты по разделам верхнего уровня; пустой запрос — пусто. */
export function searchSettings(entries: Entry[], q: string, ctx: SearchCtx): Group[] {
  const variants = layoutVariants(q).map((v) => v.split(' '));
  if (!variants.length) return [];
  const pages = new Map<string, Entry>(), byId = new Map<string, Entry>();
  for (const e of entries) { byId.set(e.id, e); if (e.kind === 'section') pages.set(e.path, e); }

  const crumbsOf = (e: Entry): string[] => {
    const seg = e.path.split('/'), out: string[] = [];
    for (let i = 2; i <= seg.length; i++) {
      const p = pages.get(seg.slice(0, i).join('/'));
      if (p && p !== e) out.push(p.title);
    }
    const parent = e.parent ? byId.get(e.parent) : undefined;
    if (parent) out.push(parent.title);
    return out;
  };

  const found: Hit[] = [];
  for (const e of entries) {
    if (e.when && !e.when(ctx)) continue;
    const title = words(e.title), crumbs = crumbsOf(e);
    const crumbWords = crumbs.flatMap(words).map((x) => x.w);
    const keyWords = (e.keywords ?? []).flatMap(words).map((x) => x.w);
    let best: { score: number; hits: [number, number][] } | null = null;
    for (const qw of variants) {
      let level = TITLE, inTitle = 0;
      const hits: [number, number][] = [];
      const ok = qw.every((w) => {
        const t = title.filter((x) => x.w.startsWith(w));
        if (t.length) { inTitle++; for (const x of t) hits.push([x.at, x.at + w.length]); return true; }
        if (keyWords.some((x) => x.startsWith(w))) { level = KEYWORDS; return true; }
        if (crumbWords.some((x) => x.startsWith(w))) { level = Math.max(level, CRUMBS); return true; }
        return false;
      });
      // крошки только уточняют: хотя бы одно слово должно найтись в самом пункте (иначе «обои» находит всё на странице обоев)
      if (!ok || (!inTitle && level !== KEYWORDS)) continue;
      if (level === TITLE && title[0]?.w.startsWith(qw[0])) level = TITLE_START;
      if (!best || level < best.score) best = { score: level, hits: level === KEYWORDS && !inTitle ? [] : merge(hits) };
    }
    if (best) found.push({ entry: e, crumbs, ...best });
  }

  found.sort(compare);
  const groups = new Map<string, Group>();
  for (const h of found) {
    const top = topOf(h.entry.path);
    let g = groups.get(top);
    if (!g) groups.set(top, g = { section: pages.get(top) ?? h.entry, items: [] });
    g.items.push(h);
  }
  return [...groups.values()];
}

/** Уровень совпадения → раздел выше пунктов → меньшая глубина → алфавит. */
function compare(a: Hit, b: Hit): number {
  return a.score - b.score
    || Number(b.entry.kind === 'section') - Number(a.entry.kind === 'section')
    || depth(a.entry) - depth(b.entry)
    || a.entry.title.localeCompare(b.entry.title, 'ru');
}

function merge(r: [number, number][]): [number, number][] {
  const s = [...r].sort((a, b) => a[0] - b[0]), out: [number, number][] = [];
  for (const x of s) {
    const last = out.at(-1);
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}
