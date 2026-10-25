// Стек слоёв навигации (как appNavigationController в Telegram Web K + пометки закрытых из telegram-tt).
// Каждый открытый слой — страница левой колонки, чат поверх чата, правая панель — своя запись: одна запись стека =
// одна запись истории браузера. Слой закрывается сам по себе (из середины стека тоже), не трогая остальные.
//
//  • push        — открыть слой: pushState (или replaceState, если просили заменить верхнюю запись);
//  • close       — слой закрыли из интерфейса: запись помечается закрытой; верхние закрытые снимаются одним go(-n);
//  • closeType   — закрыть последний открытый слой типа (его onBack + close), где бы он ни лежал;
//  • popstate    — «Назад» браузера: у всех открытых записей выше новой позиции onBack сверху вниз;
//                  чужая сессия (запись от прошлой загрузки) — закрыть всё; «вперёд» не поддерживаем.
// history.go асинхронный: операции с историей идут очередью, следующая ждёт popstate от предыдущего go.

export type LayerType = 'page' | 'screen' | 'chat' | 'info';

export interface Entry {
  id: number;
  type: LayerType | 'root';
  key?: string;
  onBack: () => void;
  closed?: boolean;
}

export interface HistoryApi {
  pushState(state: unknown, title: string): void;
  replaceState(state: unknown, title: string): void;
  go(delta: number): void;
  readonly state: unknown;
}

type NavState = { sid: number; i: number };

export interface NavStackOptions {
  /** Перед «Назад» браузера, снимающим эти записи: false — уход отменён (несохранённая форма). */
  canPop?: (popping: Entry[]) => boolean | Promise<boolean>;
}

export function createNavStack(hist: HistoryApi, opts: NavStackOptions = {}) {
  const sid = Date.now() + Math.random();
  let seq = 0;
  let entries: Entry[] = [{ id: 0, type: 'root', onBack: () => {} }];
  const ops: (() => void)[] = [];
  let waitPop = false;   // ждём popstate от своего go()

  const stamp = (i: number): NavState => ({ sid, i });
  hist.replaceState({ ...(typeof hist.state === 'object' && hist.state ? hist.state : {}), ...stamp(0) }, '');

  function run(op: () => void) {
    if (waitPop) { ops.push(op); return; }
    op();
  }
  function drain() {
    while (!waitPop && ops.length) ops.shift()!();
  }
  function goBack(n: number) {
    if (n <= 0) return;
    run(() => { waitPop = true; hist.go(-n); });
  }
  /** Снять верхние закрытые записи (без onBack: эти слои уже закрыты). */
  function trimClosed() {
    let n = 0;
    while (entries.length - 1 - n > 0 && entries[entries.length - 1 - n].closed) n++;
    if (!n) return;
    entries = entries.slice(0, entries.length - n);
    goBack(n);
  }

  return {
    /** Открыть слой. replace — заменить верхнюю запись (она закрывается без onBack). */
    push(type: LayerType, onBack: () => void, o: { key?: string; replace?: boolean } = {}): number {
      const e: Entry = { id: ++seq, type, key: o.key, onBack };
      if (o.replace && entries.length > 1) {
        const i = entries.length - 1;
        entries[i] = e;
        run(() => hist.replaceState(stamp(i), ''));
      } else {
        entries.push(e);
        const i = entries.length - 1;
        run(() => hist.pushState(stamp(i), ''));
      }
      return e.id;
    },

    /** Слой закрыли из интерфейса (onBack не вызывается — закрытие уже сделано). */
    close(id: number): void {
      const e = entries.find((x) => x.id === id);
      if (!e || e.closed || e.type === 'root') return;
      e.closed = true;
      trimClosed();
    },

    /** Закрыть последний открытый слой типа: его onBack, затем запись. false — такого слоя нет. */
    closeType(type: LayerType): boolean {
      for (let i = entries.length - 1; i > 0; i--) {
        const e = entries[i];
        if (e.type !== type || e.closed) continue;
        e.closed = true;   // до onBack: onBack может закрывать связанные записи сам
        e.onBack();
        trimClosed();
        return true;
      }
      return false;
    },

    /** Закрыть все записи типа без onBack (например, сменился нижний чат — верхние уже сняты). */
    closeAll(type: LayerType): void {
      let any = false;
      for (const e of entries) if (e.type === type && !e.closed) { e.closed = true; any = true; }
      if (any) trimClosed();
    },

    /** Верхний открытый слой (для Esc). */
    topOpen(): Entry | null {
      for (let i = entries.length - 1; i > 0; i--) if (!entries[i].closed) return entries[i];
      return null;
    },

    /** Открытые записи типа снизу вверх. */
    open(type: LayerType): Entry[] { return entries.filter((e) => e.type === type && !e.closed); },

    /** popstate браузера. */
    async onPop(state: unknown): Promise<void> {
      if (waitPop) { waitPop = false; drain(); return; }   // свой go()
      const s = state as Partial<NavState> | null;
      if (!s || s.sid !== sid || typeof s.i !== 'number') {
        // запись от прошлой загрузки (или ручной хэш): всё, что открыто, закрывается; позиция — новый корень
        for (let i = entries.length - 1; i > 0; i--) if (!entries[i].closed) { entries[i].closed = true; entries[i].onBack(); }
        entries = [entries[0]];
        hist.replaceState({ ...(s && typeof s === 'object' ? s : {}), ...stamp(0) }, '');
        return;
      }
      const to = s.i, cur = entries.length - 1;
      if (to === cur) return;
      if (to > cur) { waitPop = true; hist.go(cur - to); return; }   // «вперёд» — назад, где были
      const popping = entries.slice(to + 1).filter((e) => !e.closed);
      if (popping.length && opts.canPop && !(await opts.canPop(popping))) {
        // отказались уходить: браузер уже на to — возвращаем записи выше
        for (let i = to + 1; i <= cur; i++) hist.pushState(stamp(i), '');
        return;
      }
      for (let i = cur; i > to; i--) { const e = entries[i]; if (!e.closed) { e.closed = true; e.onBack(); } }
      entries = entries.slice(0, to + 1);
      trimClosed();   // новая верхняя — «дырка» (слой закрыт из середины раньше): снимаем и её
    },

    /** Для тестов и отладки. */
    snapshot: () => entries.map((e) => (e.closed ? `(${e.type}${e.key ? ':' + e.key : ''})` : e.type + (e.key ? ':' + e.key : ''))),
    pending: () => waitPop || ops.length > 0,
  };
}

export type NavStack = ReturnType<typeof createNavStack>;
