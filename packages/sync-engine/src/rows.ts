/** Строка таблицы в памяти воркера: seq — номер записи журнала, на момент которой она верна (0 — неизвестно);
 *  v — счётчик изменений в этой вкладке воркера (для подписи элементов запросов, не хранится на диске). */
export type Row<T> = T & { seq: number; v: number };

/** Содержимое без seq и v: примитивы по ===, вложенные объекты/массивы по JSON. */
function sameContent(a: object, b: object): boolean {
  const ka = Object.keys(a).filter((k) => k !== 'seq' && k !== 'v');
  const kb = Object.keys(b).filter((k) => k !== 'seq' && k !== 'v');
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = (a as Record<string, unknown>)[k];
    const y = (b as Record<string, unknown>)[k];
    if (x === y) continue;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
    if (JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}

/** Таблица в памяти с отметкой изменённых строк для flush. Одно правило: старое (меньший seq) не перетирает новое. */
export class Table<K, T> {
  readonly rows = new Map<K, Row<T>>();
  readonly dirty = new Set<K>();
  readonly removed = new Set<K>();

  get(k: K): Row<T> | undefined {
    return this.rows.get(k);
  }

  /** Записать, если seq не меньше сохранённого; вернёт true, если строка изменилась. */
  put(k: K, value: T, seq: number): boolean {
    const prev = this.rows.get(k);
    if (prev && seq < prev.seq) return false;
    if (prev && sameContent(prev, value as object)) {
      prev.seq = seq; // содержимое то же — только поднимаем seq, без v и flush
      return false;
    }
    this.rows.set(k, { ...value, seq, v: (prev?.v ?? 0) + 1 });
    this.dirty.add(k);
    this.removed.delete(k);
    return true;
  }

  delete(k: K): boolean {
    const had = this.rows.delete(k);
    this.removed.add(k);
    this.dirty.delete(k);
    return had;
  }

  /** Забрать изменения для write(): put — значения без v, del — ключи. */
  collect(): { put: (T & { seq: number })[]; del: K[] } {
    const put: (T & { seq: number })[] = [];
    for (const k of this.dirty) {
      const row = this.rows.get(k);
      if (!row) continue;
      const { v: _v, ...rest } = row;
      put.push(rest as unknown as T & { seq: number });
    }
    const del = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    return { put, del };
  }

  load(list: (T & { seq?: number })[], key: (x: T) => K): void {
    for (const item of list) this.rows.set(key(item), { ...item, seq: item.seq ?? 0, v: 1 } as Row<T>);
  }
}
