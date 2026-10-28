# Выбор нескольких чатов в списке — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель:** в списке чатов слева (во «Все», в своих папках и в «Архиве») можно отметить несколько чатов и разом прочитать или отметить непрочитанными, закрепить или открепить, выключить или включить звук, убрать в архив или вернуть, удалить.

**Как это выглядит:** поведение повторяет Telegram для Android и tweb. Пункт «Выбрать» в меню строки включает режим и отмечает эту строку. Над шапкой списка проявляется своя шапка: крестик, «Выбрано: N чатов», кнопка «⋮» с действиями. В строках слева появляется кружок-галочка, а содержимое строки сдвигается вправо. Клик по строке ставит или снимает отметку. Протяжка мышью отмечает несколько строк подряд.

**Как устроено:**
- Состояние режима — одно поле `chatSelect` в `global` (как `selecting` у сообщений).
- Решения о том, что предлагать в меню, — чистые функции в `apps/web/src/chatSelect.ts`, с тестами.
- Групповые действия собраны из существующих одиночных: `setChatFlags`, `setMute`, `POST /chats/:id/delete`, выход из группы.
- Кит получает две вещи: строку `ChatRow` с отметкой и шапку `SelectHeader`.

**Стек:** Bun, Preact, `@relay/ui` (JS без типов), `bun test`, `tsc`.

## Общие ограничения

- **Лицензия.** tweb под GPL. Переносим только поведение, код пишем с нуля и в tweb не подглядываем.
- **Язык.** Подписи, комментарии и PR — на русском, как во всём `apps/web`.
- **Кадры.** Вход в режим и выход — без длинных задач. Место под галочку открывается сразу, без анимации отступов. Содержимое догоняет его сдвигом через `transform`. На 300 мс включается `beginHeavyAnimation`. При `reducedMotion()` анимаций нет.
- **Прокрутка.** Строки, которые появляются в окне `WindowList` при прокрутке во включённом режиме, приходят уже с галочкой, без анимации.
- **Лимит закреплённых.** Закрепить можно не больше `PIN_LIMIT` (5) в каждом списке. Если групповое закрепление превысит лимит, показывается один тост, а на сервер ничего не уходит.
- **Удаление.** Удаление никогда не удаляет группу или канал, где я владелец. Если такой чат среди выбранных, пункта «Удалить» нет.
- **Проверка.** Только в Chrome на `https://127.0.0.1`, через chrome-devtools MCP с `isolatedContext`. Встроенная панель не подходит: в ней не работают воркеры.

## Правила меню

Правила те же, что в Android: направление выбирается так, чтобы все выбранные чаты пришли в одно состояние. Если действие нельзя применить хотя бы к одному чату, пункта нет совсем.

| Действие | Что в меню |
|---|---|
| Прочитано | Хоть один непрочитанный (счётчик или отметка) — «Отметить как прочитанные». Иначе «Отметить как непрочитанные». |
| Закрепить | Хоть один не закреплён — «Закрепить». Закреплены все — «Открепить». |
| Звук | Хоть один без звука — «Включить уведомления». Иначе «Выключить уведомления» (навсегда, как `toggleMute`). |
| Архив | Нет, если среди выбранных системный чат. Хоть один в архиве — «Вернуть из архива». Иначе «В архив». |
| Удалить | Нет, если среди выбранных системный чат или моя группа/канал. Иначе есть всегда. |

После действия режим закрывается. Исключение — удаление: если окно подтверждения отменили, режим остаётся.

## Когда режим закрывается

Режим закрывается в любом из случаев:
- сняли последнюю отметку;
- нажали крестик или Escape;
- выполнили действие;
- сменили папку;
- ушли со страницы списка (настройки, архив ↔ «Все»);
- открыли поиск.

Если выбранный чат исчез из списка (удалён, ушёл в архив с другого устройства), он выпадает из выбора.

## Файлы

| Файл | Что меняется |
|---|---|
| `apps/web/src/global.ts` | Поле `chatSelect`. |
| `apps/web/src/chatSelect.ts` (новый) | Состояние режима, правила меню, порядок, проверка лимита. |
| `apps/web/src/chatSelect.test.ts` (новый) | Тесты правил и состояния. |
| `apps/web/src/chatFlags.ts` | `pinMany`, `archiveMany`, `markUnreadMany`. |
| `apps/web/src/mute.ts` | `muteMany`. |
| `apps/web/src/ui/chatSelectRun.tsx` (новый) | Выполнение действия и окно группового удаления. |
| `packages/relay-ui/src/kit.js`, `packages/relay-ui/relay.css` | `ChatRow`: пропсы `selecting` и `selected`, галочка, место под неё, анимации. |
| `packages/relay-ui/src/more.js` | `SelectHeader`. |
| `apps/web/src/ui/Sidebar.tsx`, `apps/web/src/ui/Archive.tsx` | Пункт «Выбрать», клик-отметка, шапка, выход из режима, протяжка мышью. |
| `apps/web/src/ui/chatSelectDrag.ts` (новый) | Протяжка мышью по строкам виртуального списка. |

---

### Задача 1: модель выбора и правила меню

**Файлы:**
- Изменить: `apps/web/src/global.ts:79` (тип) и `:171` (начальное значение).
- Создать: `apps/web/src/chatSelect.ts`.
- Тест: `apps/web/src/chatSelect.test.ts`.

**Интерфейсы:**
- Отдаёт: `SelList`, `SelActions`, `SelState`, `stateOf(c, now?)`, `selectionActions(states)`, `startChatSelect(list, id)`, `toggleChatSelect(id)`, `setChatSelectIds(ids)`, `endChatSelect()`, `pruneChatSelect(has)`, `inListOrder(ids, list)`, `pinRoom(ids, chats)`.

- [ ] **Шаг 1: поле в global.** В `type Global` рядом с `selecting`:

```ts
  chatSelect: { list: 'main' | 'archive'; ids: number[] } | null;   // режим выбора чатов в списке слева (id по порядку отметки)
```

Рядом с `selecting: null,` в начальном состоянии добавить `chatSelect: null,`.

- [ ] **Шаг 2: падающий тест.** Создать `apps/web/src/chatSelect.test.ts`:

```ts
import { test, expect, beforeEach } from 'bun:test';
import { setGlobal, getGlobal } from './global';
import { endChatSelect, inListOrder, pinRoom, pruneChatSelect, selectionActions, setChatSelectIds, startChatSelect, stateOf, toggleChatSelect, type SelState } from './chatSelect';

const S = (o: Partial<SelState> = {}): SelState => ({ pinned: false, unread: false, muted: false, archived: false, system: false, owner: false, ...o });

test('пусто — ничего не предлагаем', () => { expect(selectionActions([])).toEqual({}); });
test('закрепить, пока хоть один не закреплён', () => {
  expect(selectionActions([S({ pinned: true }), S()]).pin).toBe(true);
  expect(selectionActions([S({ pinned: true }), S({ pinned: true })]).pin).toBe(false);
});
test('один без звука — включить звук всем', () => {
  expect(selectionActions([S({ muted: true }), S()]).mute).toBe(false);
  expect(selectionActions([S(), S()]).mute).toBe(true);
});
test('один в архиве — вернуть всех; системный — архива нет', () => {
  expect(selectionActions([S({ archived: true }), S()]).archive).toBe(false);
  expect(selectionActions([S(), S()]).archive).toBe(true);
  expect(selectionActions([S({ system: true }), S()]).archive).toBeUndefined();
});
test('прочитать, если есть непрочитанный; иначе отметить непрочитанными', () => {
  expect(selectionActions([S({ unread: true }), S()]).read).toBe(true);
  expect(selectionActions([S(), S()]).read).toBe(false);
});
test('удалить — не для системного и не для своей группы', () => {
  expect(selectionActions([S(), S()]).delete).toBe(true);
  expect(selectionActions([S({ owner: true }), S()]).delete).toBeUndefined();
  expect(selectionActions([S({ system: true })]).delete).toBeUndefined();
});
test('stateOf: владелец группы, отметка непрочитанного', () => {
  const s = stateOf({ id: 1, kind: 'group', me: { role: 'owner' }, unread: 0, unreadMark: true, pinnedAt: 5 });
  expect(s).toMatchObject({ owner: true, unread: true, pinned: true, archived: false, system: false });
});

beforeEach(() => setGlobal({ chatSelect: null }));
test('отметка, снятие, выход на последней', () => {
  startChatSelect('main', 3);
  toggleChatSelect(7);
  expect(getGlobal().chatSelect).toEqual({ list: 'main', ids: [3, 7] });
  toggleChatSelect(3); toggleChatSelect(7);
  expect(getGlobal().chatSelect).toBeNull();
});
test('протяжка задаёт набор целиком; пустой — выход', () => {
  startChatSelect('archive', 1);
  setChatSelectIds([1, 2, 3]);
  expect(getGlobal().chatSelect?.ids).toEqual([1, 2, 3]);
  setChatSelectIds([]);
  expect(getGlobal().chatSelect).toBeNull();
});
test('пропавшие из списка выпадают', () => {
  startChatSelect('main', 1); toggleChatSelect(2);
  pruneChatSelect((id) => id !== 2);
  expect(getGlobal().chatSelect?.ids).toEqual([1]);
  pruneChatSelect(() => false);
  expect(getGlobal().chatSelect).toBeNull();
  endChatSelect();
});
test('порядок — как в списке', () => {
  expect(inListOrder([9, 1, 5], [{ id: 1 }, { id: 5 }, { id: 9 }])).toEqual([1, 5, 9]);
});
test('лимит закреплённых — по своему списку', () => {
  const chats = [1, 2, 3, 4].map((id) => ({ id, pinnedAt: id })).concat([{ id: 10 }, { id: 11 }, { id: 12, archived: true, pinnedAt: 1 }] as never);
  expect(pinRoom([10], chats)).toBe(true);        // 4 + 1 = 5
  expect(pinRoom([10, 11], chats)).toBe(false);   // 4 + 2 > 5
});
```

- [ ] **Шаг 3: тест падает.** `bun test apps/web/src/chatSelect.test.ts`. Ожидается: FAIL, `Cannot find module './chatSelect'`.

- [ ] **Шаг 4: реализация.** Создать `apps/web/src/chatSelect.ts`:

```ts
// Выбор нескольких чатов в списке слева — как в Telegram для Android: «Выбрать» в меню строки включает режим,
// клик по строке отмечает, шапка считает выбранное и предлагает то, что можно сделать со всеми сразу.
// Направление действия — то, что приводит все выбранные к одному состоянию; нельзя хоть с одним — пункта нет.
import type { MyMembership } from '@relay/protocol';
import { getGlobal, setGlobal } from './global';
import { PIN_LIMIT, hasUnreadMark, isArchived, isPinned } from './chatFlags';
import { isMuted } from './mute';
import { isSystemChat } from './ui/format';

export type SelList = 'main' | 'archive';
type Chat = Record<string, unknown>;

/** Что можно сделать с выбранным: нет ключа — пункта нет; значение — направление (pin: false — открепить, read: false — непрочитанные). */
export type SelActions = Partial<Record<'read' | 'pin' | 'mute' | 'archive' | 'delete', boolean>>;
export type SelState = { pinned: boolean; unread: boolean; muted: boolean; archived: boolean; system: boolean; owner: boolean };

export function stateOf(c: Chat, now = Date.now()): SelState {
  const me = (c.me as MyMembership | null | undefined) ?? null;
  return {
    pinned: isPinned(c), unread: (c.unread as number) > 0 || hasUnreadMark(c), muted: isMuted(c, now),
    archived: isArchived(c), system: isSystemChat(c),
    owner: (c.kind === 'group' || c.kind === 'channel') && me?.role === 'owner',
  };
}

export function selectionActions(list: SelState[]): SelActions {
  if (!list.length) return {};
  const a: SelActions = {
    read: list.some((s) => s.unread),
    pin: list.some((s) => !s.pinned),
    mute: !list.some((s) => s.muted),   // один без звука — включить звук всем (как в Android)
  };
  if (!list.some((s) => s.system)) a.archive = !list.some((s) => s.archived);
  if (!list.some((s) => s.system || s.owner)) a.delete = true;   // своя группа удаляется только целиком — не из списка
  return a;
}

const put = (list: SelList, ids: number[]) => setGlobal({ chatSelect: ids.length ? { list, ids } : null });

export function startChatSelect(list: SelList, id: number): void { put(list, [id]); }
export function toggleChatSelect(id: number): void {
  const s = getGlobal().chatSelect;
  if (s) put(s.list, s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id]);
}
/** Протяжка мышью задаёт набор целиком. */
export function setChatSelectIds(ids: number[]): void { const s = getGlobal().chatSelect; if (s) put(s.list, ids); }
export function endChatSelect(): void { if (getGlobal().chatSelect) setGlobal({ chatSelect: null }); }
/** Чат пропал из списка (удалён, ушёл в архив с другого устройства) — из выбора выпадает. */
export function pruneChatSelect(has: (id: number) => boolean): void {
  const s = getGlobal().chatSelect;
  if (s && !s.ids.every(has)) put(s.list, s.ids.filter(has));
}

/** Выбранные в порядке списка, сверху вниз. */
export function inListOrder(ids: readonly number[], list: readonly { id: unknown }[]): number[] {
  const set = new Set(ids);
  return list.map((c) => c.id as number).filter((id) => set.has(id));
}

/** Хватит ли места закрепить ids: у «Всех» и «Архива» лимит свой (chatFlags.PIN_LIMIT). */
export function pinRoom(ids: readonly number[], chats: readonly Chat[]): boolean {
  const byId = new Map(chats.map((c) => [c.id as number, c]));
  for (const archived of [false, true]) {
    const add = ids.filter((id) => { const c = byId.get(id); return c && !isPinned(c) && isArchived(c) === archived; }).length;
    if (add && chats.filter((c) => isPinned(c) && isArchived(c) === archived).length + add > PIN_LIMIT) return false;
  }
  return true;
}
```

- [ ] **Шаг 5: тест проходит.** `bun test apps/web/src/chatSelect.test.ts`. Ожидается: PASS. Затем `cd apps/web && bunx tsc --noEmit -p .`: 0 ошибок. Если `isMuted` или `isSystemChat` не принимают `Record<string, unknown>`, привести тип в вызове: `c as never`, как в `Sidebar.tsx`.

- [ ] **Шаг 6: коммит.**

```bash
git add apps/web/src/global.ts apps/web/src/chatSelect.ts apps/web/src/chatSelect.test.ts
git commit -m "feat(web): модель выбора нескольких чатов и правила меню"
```

---

### Задача 2: групповые действия

**Файлы:**
- Изменить: `apps/web/src/chatFlags.ts` (в конец), `apps/web/src/mute.ts` (рядом с `toggleMute`).
- Создать: `apps/web/src/ui/chatSelectRun.tsx`.
- Тест: дописать в `apps/web/src/chatSelect.test.ts`.

**Интерфейсы:**
- Берёт: `pinRoom`, `inListOrder`, `endChatSelect` из задачи 1.
- Отдаёт:
  - `pinMany(ids, pinned): boolean`;
  - `archiveMany(ids, archived)`;
  - `markUnreadMany(ids, unread)`;
  - `muteMany(ids, muted)`;
  - `runChatAction(action, dir, ids): 'done' | 'ask-delete'`;
  - `useBulkDelete(): { open(ids): void; node }`.

- [ ] **Шаг 1: падающий тест на лимит.** Дописать в `chatSelect.test.ts`:

```ts
import { bindChatFlags, pinMany } from './chatFlags';

test('pinMany: лимит — один тост, на сервер ничего', async () => {
  const sent: number[] = [];
  bindChatFlags(async (id) => { sent.push(id); });
  setGlobal({ chats: [1, 2, 3, 4].map((id) => ({ id, pinnedAt: id })).concat([{ id: 10 }, { id: 11 }] as never) as never });
  expect(pinMany([10, 11], true)).toBe(false);
  expect(sent).toEqual([]);
  expect(pinMany([10], true)).toBe(true);
  expect(sent).toEqual([10]);
});
test('pinMany: снизу вверх — верхний окажется выше (позже закреплён — выше)', () => {
  const sent: number[] = [];
  bindChatFlags(async (id) => { sent.push(id); });
  setGlobal({ chats: [{ id: 1 }, { id: 2 }, { id: 3 }] as never });
  pinMany([1, 3], true);
  expect(sent).toEqual([3, 1]);
});
```

- [ ] **Шаг 2: тест падает.** `bun test apps/web/src/chatSelect.test.ts`. Ожидается: FAIL, `pinMany is not a function`.

- [ ] **Шаг 3: chatFlags.** Дописать в конец `apps/web/src/chatFlags.ts`. Если это даст цикл импортов `chatFlags ↔ chatSelect`, перенести `pinRoom` в `chatFlags.ts`, а в `chatSelect.ts` реэкспортировать.

```ts
import { inListOrder, pinRoom } from './chatSelect';

/**
 * Закрепить / открепить несколько. Порядок закреплённых — по времени закрепления (позже — выше), поэтому
 * шлём снизу вверх: верхний из выбранных окажется выше. Не влезает в лимит — тост, ничего не уходит.
 */
export function pinMany(ids: number[], pinned: boolean): boolean {
  const chats = getGlobal().chats;
  const todo = inListOrder(ids, chats).filter((id) => isPinned(chatById(id)) !== pinned);
  if (pinned && !pinRoom(todo, chats)) { showToast(`Закрепить можно не больше ${PIN_LIMIT} чатов. Открепите один из них.`, 3500); return false; }
  for (const id of (pinned ? todo.reverse() : todo)) send(id, { pinned });
  return true;
}

export function archiveMany(ids: number[], archived: boolean): void {
  const todo = ids.filter((id) => isArchived(chatById(id)) !== archived);
  for (const id of todo) send(id, { archived });
  if (todo.length) showToast(archived ? (todo.length > 1 ? 'Чаты перенесены в архив' : 'Чат перенесён в архив') : (todo.length > 1 ? 'Чаты возвращены из архива' : 'Чат возвращён из архива'));
}

/** Отметка «непрочитано»; снять — только с тех, у кого она есть (счётчик гасит data.seen в chatSelectRun). */
export function markUnreadMany(ids: number[], unread: boolean): void {
  for (const id of ids) if (hasUnreadMark(chatById(id)) !== unread) send(id, { unreadMark: unread });
}
```

- [ ] **Шаг 4: mute.** В `apps/web/src/mute.ts` после `toggleMute`:

```ts
/** Звук нескольким сразу: выключить — навсегда (как toggleMute), включить — только тем, у кого выключен. */
export function muteMany(ids: number[], muted: boolean): void {
  for (const id of ids) if (isChatMuted(id) !== muted) { if (muted) muteChat(id, null); else unmuteChat(id); }
}
```

- [ ] **Шаг 5: выполнение и групповое удаление.** Создать `apps/web/src/ui/chatSelectRun.tsx`:

```tsx
// Действие из меню выбора чатов — над всеми выбранными сразу. «Прочитать» — как в меню строки: счётчик гасит
// seen до последнего сообщения, отметку снимает chatFlags. Удаление — через окно (useBulkDelete).
import { useState } from 'preact/hooks';
import { Checkbox, ConfirmDialog, plural } from '@relay/ui';
import { archiveMany, markUnreadMany, pinMany } from '../chatFlags';
import { muteMany } from '../mute';
import { closeChat, seen } from '../data';
import { findChat, getGlobal } from '../global';
import { act } from '../groups';
import type { SelActions } from '../chatSelect';

export function runChatAction(action: keyof SelActions, dir: boolean, ids: number[]): 'done' | 'ask-delete' {
  if (action === 'delete') return 'ask-delete';
  if (action === 'pin') pinMany(ids, dir);
  else if (action === 'archive') archiveMany(ids, dir);
  else if (action === 'mute') muteMany(ids, dir);
  else if (dir) {
    for (const id of ids) {
      const c = findChat(getGlobal(), id);
      const last = ((c?.last as { id?: number | null } | null)?.id ?? 0) || (c?.knownMaxId as number) || 0;
      if ((c?.unread as number) > 0 && last) seen(id, last);
    }
    markUnreadMany(ids, false);
  } else markUnreadMany(ids, true);
  return 'done';
}

/**
 * Удалить несколько: личные чаты — POST /chats/:id/delete (галочка «и у собеседников» — forAll),
 * группы и каналы — выйти (своих среди выбранных нет: selectionActions не предлагает удаление).
 */
export function useBulkDelete(onDone: () => void): { open: (ids: number[]) => void; node: preact.JSX.Element } {
  const [ids, setIds] = useState<number[] | null>(null);
  const [forAll, setForAll] = useState(false);
  const s = getGlobal();
  const personal = (ids ?? []).filter((id) => findChat(s, id)?.kind === 'direct');
  const run = async () => {
    const list = ids!; setIds(null); onDone();
    const me = getGlobal().me?.userId;
    await Promise.all(list.map((id) => findChat(getGlobal(), id)?.kind === 'direct'
      ? act('POST', `/chats/${id}/delete`, { forAll })
      : act('DELETE', `/groups/${id}/members/${me}`)));
    if (list.includes(getGlobal().openChatId as number)) closeChat();
  };
  const n = ids?.length ?? 0;
  const node = (
    <ConfirmDialog open={!!ids} danger title={`Удалить ${n} ${plural(n, 'чат', 'чата', 'чатов')}`}
      text="Это действие нельзя отменить. Из групп и каналов вы выйдете." confirm="Удалить"
      onConfirm={() => void run()} onCancel={() => setIds(null)}>
      {personal.length ? <Checkbox id="bulk-del-all" checked={forAll} onChange={() => setForAll(!forAll)}>Удалить и у собеседников, где возможно</Checkbox> : null}
    </ConfirmDialog>
  );
  return { open: (list) => { setForAll(false); setIds(list); }, node };
}
```

Перед этим проверить три вещи:
- Как в `Item` называется вид личного чата. Найти `kind ===` в `apps/web/src/ui/format.ts` и подставить в `'direct'` настоящее значение.
- Принимает ли `ConfirmDialog` (`packages/relay-ui/src/settings.js:124`) детей. Сейчас он рисует только `text`. Добавить вторым ребёнком `Modal` `props.children` и запустить тест `settings.test.js`.
- Экспортируются ли `plural` и `Checkbox` из `@relay/ui`. Если нет, добавить в экспорт.

- [ ] **Шаг 6: проверки.** `bun test apps/web/src/chatSelect.test.ts` — PASS. `bunx tsc --noEmit -p apps/web` — 0 ошибок.

- [ ] **Шаг 7: коммит.**

```bash
git add apps/web/src/chatFlags.ts apps/web/src/mute.ts apps/web/src/ui/chatSelectRun.tsx apps/web/src/chatSelect.test.ts packages/relay-ui/src/settings.js
git commit -m "feat(web): групповые действия над выбранными чатами"
```

---

### Задача 3: строка с отметкой (кит)

**Файлы:**
- Изменить: `packages/relay-ui/src/kit.js:495-551` (`ChatRow`), `packages/relay-ui/relay.css` (после `.rl-row[aria-current="true"]`, строка 112).
- Тест: `packages/relay-ui/src/chatRowSelect.test.js` (новый).

**Интерфейсы:**
- Отдаёт: у `ChatRow` новые пропсы `selecting: boolean` и `selected: boolean`.
- Классы:
  - `rl-row-sel` — строка в режиме;
  - `rl-row-sel-on` — строка отмечена;
  - `rl-row-check` — кружок с галочкой;
  - `rl-sel-anim` — ставится на обёртку списка на время входа или выхода.

- [ ] **Шаг 1: падающий тест.** Создать `packages/relay-ui/src/chatRowSelect.test.js`. Как рендерить в тестах кита, посмотреть в соседних тестах, например `emojiBubble.test.js`. Ниже — вариант через `preact-render-to-string`, если он есть в зависимостях. Если его нет — через `render` в happy-dom, как в соседних тестах.

```js
import { test, expect } from 'bun:test';
import { h } from 'preact';
import { render } from 'preact-render-to-string';
import { ChatRow } from './kit.js';

test('вне режима — без галочки', () => {
  const html = render(h(ChatRow, { name: 'A', preview: 'x', time: '1' }));
  expect(html).not.toContain('rl-row-check');
});
test('в режиме — галочка; отмеченная — aria-pressed', () => {
  const off = render(h(ChatRow, { name: 'A', preview: 'x', time: '1', selecting: true, selected: false }));
  const on = render(h(ChatRow, { name: 'A', preview: 'x', time: '1', selecting: true, selected: true }));
  expect(off).toContain('rl-row-check');
  expect(off).toContain('aria-pressed="false"');
  expect(on).toContain('rl-row-sel-on');
  expect(on).toContain('aria-pressed="true"');
});
```

- [ ] **Шаг 2: тест падает.** `bun test packages/relay-ui/src/chatRowSelect.test.js`. Ожидается: FAIL, в разметке нет `rl-row-check`.

- [ ] **Шаг 3: ChatRow.**
  - Добавить `'selecting', 'selected'` в список `omit`.
  - В атрибуты кнопки добавить `'aria-pressed': props.selecting ? String(!!props.selected) : undefined`.
  - В `cx(...)` добавить `props.selecting && 'rl-row-sel', props.selecting && props.selected && 'rl-row-sel-on'`.
  - Первым ребёнком, до `Avatar`, вставить:

```js
    props.selecting ? h('span', { class: 'rl-row-check', 'aria-hidden': 'true' },
      h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, h('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }))) : null,
```

- [ ] **Шаг 4: CSS.** В `relay.css` после строки 112:

```css
/* Выбор нескольких чатов: кружок слева, под него — полоса 36 px. Полоса открывается сразу (раскладка один раз),
   содержимое догоняет сдвигом — transform, без раскладки на каждом кадре (как в Telegram). */
.rl-row { position: relative; }
.rl-row-sel { padding-inline-start: 45px; }
.rl-row-check { position: absolute; inset-inline-start: 12px; top: 50%; width: 22px; height: 22px; margin-top: -11px; border-radius: 50%; border: 2px solid var(--ink-3); display: grid; place-items: center; color: transparent; transition: background-color var(--dur-instant) var(--ease-out), border-color var(--dur-instant) var(--ease-out); pointer-events: none; }
.rl-row-sel-on .rl-row-check { background: var(--accent); border-color: var(--accent); color: var(--on-accent, #fff); }
.rl-row-sel-on { background: var(--hover); }
/* анимация только в момент входа/выхода (класс на обёртке списка ставит Sidebar на 300 мс):
   строки, пришедшие при прокрутке во включённом режиме, появляются уже готовыми */
.rl-sel-anim .rl-row-check { animation: rl-fade-in var(--dur-base, .3s) var(--ease-out) both; }
.rl-sel-anim .rl-row-sel > :not(.rl-row-check) { animation: rl-sel-lane var(--dur-base, .3s) var(--ease-out) both; }
.rl-sel-anim.rl-sel-leave .rl-row > :not(.rl-row-check) { animation: rl-sel-lane-out var(--dur-base, .3s) var(--ease-out) both; }
@keyframes rl-sel-lane { from { transform: translateX(-36px); } to { transform: none; } }
@keyframes rl-sel-lane-out { from { transform: translateX(36px); } to { transform: none; } }
@media (prefers-reduced-motion: reduce) { .rl-sel-anim .rl-row-check, .rl-sel-anim .rl-row > * { animation: none; } }
```

Перед вставкой:
- Проверить имена токенов в `relay.css`: `--ink-3`, `--accent`, `--dur-base`, а также есть ли keyframes `rl-fade-in`. Подставить настоящие.
- Для RTL сдвиг брать из `--reflect`, если он в ките есть (`grep -n reflect packages/relay-ui/relay.css`).
- `position: relative` у `.rl-row` может уже стоять. Если так, вторую строку не добавлять.

- [ ] **Шаг 5: тест проходит.** `bun test packages/relay-ui` — PASS, остальные тесты кита не сломаны.

- [ ] **Шаг 6: коммит.**

```bash
git add packages/relay-ui/src/kit.js packages/relay-ui/relay.css packages/relay-ui/src/chatRowSelect.test.js
git commit -m "feat(relay-ui): строка чата с отметкой для выбора нескольких"
```

---

### Задача 4: шапка выбора (кит)

**Файлы:**
- Изменить: `packages/relay-ui/src/more.js`: функцию поставить рядом с `SelectionBar` (строка 138), добавить в экспорт на строке 1225. Изменить также `packages/relay-ui/relay.css`.

**Интерфейсы:**
- Отдаёт: `SelectHeader({ count, onCancel, getItems })`. `getItems()` вызывается при каждом открытии меню и возвращает пункты `MenuPopover`.

- [ ] **Шаг 1: компонент.**

```js
/* ---------- SelectHeader: шапка списка в режиме выбора чатов ----------
   Ложится поверх обычной шапки и проявляется (как в Telegram). Пункты меню собираются при каждом открытии —
   getItems() видит текущее состояние выбранных (закреплён ли, без звука ли). count держится и на выходе:
   шапка гаснет с тем числом, с которым уходила, а не досчитывает до нуля. */
function SelectHeader(props) {
  var btn = useRef(null), open = useState(false), items = useState([]);
  var n = props.count || 0;
  return h('div', { class: 'rl-selhead', role: 'toolbar', 'aria-label': 'Выбор чатов' },
    h(IconButton, { icon: 'close', label: 'Отменить выбор', onClick: props.onCancel }),
    h('span', { class: 'rl-selhead-count', 'aria-live': 'polite' }, 'Выбрано: ' + n + ' ' + plural(n, 'чат', 'чата', 'чатов')),
    h('span', { ref: btn }, h(IconButton, { icon: 'more', label: 'Действия с выбранными', 'aria-haspopup': 'menu', 'aria-expanded': String(open[0]),
      onClick: function () { items[1](props.getItems()); open[1](true); } })),
    h(MenuPopover, { open: open[0], anchor: btn.current || undefined, placement: 'bottom-end', label: 'Действия с выбранными', items: items[0], onClose: function () { open[1](false); } }));
}
```

Если `MenuPopover` объявлен в другом файле кита, импортировать его так же, как это делает `profileActions.js`.

- [ ] **Шаг 2: CSS.**

```css
/* шапка выбора чатов — поверх шапки списка (Presence: проявление 200 мс) */
.rl-selhead { position: absolute; inset: 0 0 auto 0; z-index: 4; display: flex; align-items: center; gap: 8px; height: var(--size-header, 56px); padding: 0 8px; background: var(--surface); }
.rl-selhead-count { flex: 1; font-weight: 600; font-size: 17px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rl-presence > .rl-selhead { transition: opacity .2s var(--ease-out); }
.rl-presence[data-state="closing"] > .rl-selhead { opacity: 0; }
```

Высоту шапки взять из стиля `SidebarHeader`, токен фона — из стиля `.rl-sidepage`. Как `Presence` проявляет содержимое при монтировании, смотреть в `kit.js` (`function Presence`), и повторить этот приём.

- [ ] **Шаг 3: проверки.** `bun test packages/relay-ui` — PASS. Сборка проходит: `bun apps/web/build.ts` с `WEB_OUT` во временную папку.

- [ ] **Шаг 4: коммит.**

```bash
git add packages/relay-ui/src/more.js packages/relay-ui/relay.css
git commit -m "feat(relay-ui): шапка режима выбора чатов"
```

---

### Задача 5: режим в списке «Все», в папках и в «Архиве»

**Файлы:**
- Изменить:
  - `apps/web/src/ui/Sidebar.tsx`: `SideRow` (строки 62–102), `Sidebar` (шапка — строка 307, `renderFolder` — строка 226), `RowMenu` (строки 355–392);
  - `apps/web/src/ui/Archive.tsx`.

**Интерфейсы:**
- Берёт:
  - из задачи 1 — `startChatSelect`, `toggleChatSelect`, `endChatSelect`, `pruneChatSelect`, `stateOf`, `selectionActions`, `inListOrder`;
  - из задачи 2 — `runChatAction`, `useBulkDelete`;
  - из задач 3 и 4 — `ChatRow.selecting/selected`, `SelectHeader`.
- Отдаёт: `useChatSelectMode(list, rows)`. Это хук для `Sidebar` и `Archive`: возвращает шапку, класс обёртки и узел окна удаления.

- [ ] **Шаг 1: строка.** У `SideRow` появляются пропсы `selecting` и `selected`, которые прокидываются в `ChatRow`. Если `selecting` включён:
  - вместо `pressOpen(...)` ставится `onClick={() => toggleChatSelect(c.id as number)}`;
  - `onContextMenu` тоже отмечает строку: `e.preventDefault(); toggleChatSelect(id)`. Меню строки в режиме не открывается, как в tweb.

  `memo` сохраняется: оба пропса — булевы.

- [ ] **Шаг 2: пункт «Выбрать».** В `RowMenu` пункт идёт сразу после «Открыть в новой вкладке». Сначала добавить в `RowMenu` проп `list: 'main' | 'archive'`.

```tsx
{ icon: 'checkCircle', label: 'Выбрать', onClick: () => { onClose(); startChatSelect(list, id); } },
```

`Sidebar` передаёт `list="main"`, `Archive` — `list="archive"`.

- [ ] **Шаг 3: хук режима.** Создать в `apps/web/src/ui/chatSelectRun.tsx`:

```tsx
/**
 * Режим выбора для одного списка (Sidebar — 'main', Archive — 'archive'): шапка поверх своей, класс анимации
 * на обёртку списка на время входа/выхода, Escape, выход при смене страницы/папки/поиска, чистка пропавших.
 */
export function useChatSelectMode(list: SelList, rows: readonly Item[]) {
  const sel = useGlobal((s) => (s.chatSelect?.list === list ? s.chatSelect : null));
  const folder = useGlobal((s) => s.folder), view = useGlobal((s) => s.sidebarView), searchOpen = useGlobal((s) => s.searchOpen);
  const on = !!sel;
  const lastCount = useRef(0);
  if (sel) lastCount.current = sel.ids.length;
  // анимация — только в момент смены режима (300 мс), с паузой остальных анимаций приложения
  const [anim, setAnim] = useState<null | 'in' | 'out'>(null);
  const was = useRef(on);
  useEffect(() => {
    if (was.current === on) return;
    was.current = on;
    if (reducedMotion()) return;
    setAnim(on ? 'in' : 'out');
    const end = beginHeavyAnimation(300);
    const t = setTimeout(() => { setAnim(null); end(); }, 300);
    return () => { clearTimeout(t); end(); };
  }, [on]);
  useEffect(() => endChatSelect, [folder, view, searchOpen]);   // ушли со списка — выбор закончен
  useEffect(() => { if (on) pruneChatSelect((id) => rows.some((c) => c.id === id)); }, [rows, on]);
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); endChatSelect(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [on]);
  const del = useBulkDelete(endChatSelect);
  const getItems = () => {
    const s = getGlobal(), ids = inListOrder(s.chatSelect?.ids ?? [], s.chats);
    const a = selectionActions(ids.map((id) => stateOf(findChat(s, id) as never)));
    const item = (k: keyof SelActions, icon: string, label: string, danger?: boolean) => ({ icon, label, danger, onClick: () => {
      if (runChatAction(k, a[k]!, ids) === 'ask-delete') del.open(ids); else endChatSelect();
    } });
    return [
      ...(a.read === undefined ? [] : [a.read ? item('read', 'markRead', 'Отметить как прочитанные') : item('read', 'markUnread', 'Отметить как непрочитанные')]),
      ...(a.pin === undefined ? [] : [item('pin', a.pin ? 'pin' : 'unpin', a.pin ? 'Закрепить' : 'Открепить')]),
      ...(a.mute === undefined ? [] : [item('mute', a.mute ? 'bellOff' : 'bell', a.mute ? 'Выключить уведомления' : 'Включить уведомления')]),
      ...(a.archive === undefined ? [] : [item('archive', a.archive ? 'archive' : 'unarchive', a.archive ? 'В архив' : 'Вернуть из архива')]),
      ...(a.delete ? ['-' as const, item('delete', 'trash', 'Удалить', true)] : []),
    ];
  };
  const header = (
    <Presence show={on} exitMs={200}>
      <SelectHeader count={sel?.ids.length ?? lastCount.current} onCancel={endChatSelect} getItems={getItems} />
    </Presence>
  );
  const wrapClass = anim ? ' rl-sel-anim' + (anim === 'out' ? ' rl-sel-leave' : '') : '';
  // на выходе строки ещё 300 мс в режиме — кружок гаснет на месте, содержимое едет обратно (rl-sel-leave)
  const rowsSelecting = on || anim === 'out';
  return { sel, header, wrapClass, rowsSelecting, node: del.node };
}
```

Нужные импорты:
- `Item`;
- `SelList`, `SelActions`;
- `useGlobal`, `getGlobal`, `findChat`;
- `beginHeavyAnimation`, `reducedMotion`, `Presence`, `SelectHeader`;
- `useEffect`, `useRef`, `useState`.

Посмотреть в `useChatDialogs`, как этот хук держит `onDone`. Важно: на выходе нужно рисовать строки ещё 300 мс с `selecting` (через `rowsSelecting`), иначе кружку не из чего гаснуть.

- [ ] **Шаг 4: подключение в Sidebar.**
  - `const mode = useChatSelectMode('main', chats)`.
  - В `SidebarCard header=` передать `<>{<SidebarHeader …/>}{mode.header}</>`. У родителя шапки должен быть `position: relative`; проверить в `relay.css`, что это так.
  - В `renderFolder` добавить `mode.wrapClass` к `class` обёртки `app-listwrap`.
  - В `render` строки `WindowList` передать `selecting={mode.rowsSelecting}` и `selected={!!mode.sel?.ids.includes(c.id as number)}`.
  - `tagSpace` в режиме уменьшить на 36: место под галочку сужает строку.
  - `{mode.node}` рядом с `{folderMenu.node}`.
  - Строка «Архив» (`ArchivedRow`) в выборе не участвует. В режиме клик по ней ничего не делает: передать `onClick={mode.sel ? undefined : …}`.

- [ ] **Шаг 5: подключение в Archive.** То же с `useChatSelectMode('archive', list)`. Шапку `PanelHeader` обернуть в `<div class="app-archive-head">` с `position: relative` и положить `mode.header` внутрь.

- [ ] **Шаг 6: проверки.** `bunx tsc --noEmit -p apps/web` — 0 ошибок. `bun test apps/web` из корня — всё зелёное, как сейчас (352 и больше).

- [ ] **Шаг 7: ручная проверка в Chrome.** Через chrome-devtools MCP с `isolatedContext: relay-select`, на `https://127.0.0.1`, вход за «Анна Смирнова». Провести сценарии:
  1. Правая кнопка → «Выбрать» → шапка «Выбрано: 1 чат», галочка, строки сдвинуты.
  2. Клик по второй строке — 2 чата. Клик по обеим — режим закрывается.
  3. «⋮» → «Закрепить» на шести незакреплённых — тост про лимит, ничего не закреплено.
  4. «В архив» на двух — чаты ушли в «Архив», тост «Чаты перенесены в архив».
  5. Режим в «Архиве», «Вернуть из архива» — чаты вернулись.
  6. Escape, смена папки, открытие поиска — каждое закрывает режим.
  7. Прокрутка вниз в режиме — новые строки приходят с галочкой, без анимации.

  На каждый шаг сделать скриншот.

- [ ] **Шаг 8: коммит.**

```bash
git add apps/web/src/ui/Sidebar.tsx apps/web/src/ui/Archive.tsx apps/web/src/ui/chatSelectRun.tsx apps/web/public/app.css
git commit -m "feat(web): выбор нескольких чатов в списке и в архиве"
```

---

### Задача 6: протяжка мышью

**Файлы:**
- Создать: `apps/web/src/ui/chatSelectDrag.ts`.
- Изменить: `apps/web/src/ui/Sidebar.tsx` и `apps/web/src/ui/Archive.tsx`: обработчик на обёртке `app-listwrap`.
- Изменить: `apps/web/src/ui/Sidebar.tsx` (`SideRow`): добавить строке `data-chat-id={c.id}`. `ChatRow` пробрасывает остальные пропсы в кнопку.

**Интерфейсы:**
- Отдаёт: `chatSelectDrag(e: PointerEvent, rows: readonly Item[], scroller: HTMLElement): void`. Вызывается из `onPointerDownCapture` обёртки, только пока режим включён.

Приём тот же, что у выбора сообщений в `Feed.tsx:1470-1530`. Отличия:
- строки ищутся по `[data-chat-id]`;
- индекс берётся из `rows`, то есть из порядка списка, а не из DOM: в окне `WindowList` есть не все строки.

- [ ] **Шаг 1: модуль.**

```ts
// Протяжка мышью в режиме выбора чатов: от строки, где нажали, до строки под курсором — отметить (или снять,
// если начали с отмеченной). Как у выбора сообщений (Feed.onSelectDown): до 5 px — ещё клик, у края — автопрокрутка.
// Индексы — из списка (в окне WindowList есть не все строки), строка под курсором — elementFromPoint по середине.
import type { Item } from '@relay/sync-engine/src/types';
import { getGlobal } from '../global';
import { setChatSelectIds } from '../chatSelect';

let swallowClick = false;
/** click после протягивания не должен переключить строку ещё раз (onClickCapture обёртки). */
export function dragClickGuard(e: MouseEvent): void { if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); } }

export function chatSelectDrag(e: PointerEvent, rows: readonly Item[], scroller: HTMLElement): void {
  if (e.button !== 0 || e.pointerType === 'touch') return;
  const row = (e.target as Element).closest<HTMLElement>('[data-chat-id]');
  const start = row ? rows.findIndex((c) => String(c.id) === row.dataset.chatId) : -1;
  if (start < 0) return;
  const base = getGlobal().chatSelect?.ids ?? [];
  const add = !base.includes(rows[start].id as number);
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false, y = y0, raf = 0;
  const at = (py: number) => {
    const r = scroller.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(r.top + 1, Math.min(r.bottom - 1, py)))?.closest<HTMLElement>('[data-chat-id]');
    return hit ? rows.findIndex((c) => String(c.id) === hit.dataset.chatId) : -1;
  };
  const apply = () => {
    const i = at(y); if (i < 0) return;
    const [a, b] = start <= i ? [start, i] : [i, start];
    const range = new Set(rows.slice(a, b + 1).map((c) => c.id as number));
    setChatSelectIds(add ? [...new Set([...base, ...range])] : base.filter((id) => !range.has(id)));
  };
  const tick = () => {
    const r = scroller.getBoundingClientRect(), edge = 48;
    const v = y < r.top + edge ? -Math.ceil((r.top + edge - y) / 4) : y > r.bottom - edge ? Math.ceil((y - (r.bottom - edge)) / 4) : 0;
    if (v) { scroller.scrollTop += v; apply(); }
    raf = requestAnimationFrame(tick);
  };
  const move = (ev: PointerEvent) => {
    y = ev.clientY;
    if (!moved) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      moved = true; raf = requestAnimationFrame(tick);
    }
    apply();
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    cancelAnimationFrame(raf);
    if (moved) { swallowClick = true; setTimeout(() => { swallowClick = false; }, 0); }
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}
```

`setChatSelectIds([])` закрывает режим. Это то же поведение, что и при снятии последней отметки кликом.

- [ ] **Шаг 2: подключение.** На обёртку `app-listwrap` (`Sidebar.renderFolder` и `Archive`) повесить:
  - `onPointerDownCapture={mode.sel ? (e) => chatSelectDrag(e, list, e.currentTarget.closest('.rl-page-scroll')!) : undefined}`;
  - `onClickCapture={mode.sel ? dragClickGuard : undefined}`.

  В `Sidebar` в `list` попадает `listOf(f)` этой страницы. Надо проверить, что `ripple` на `pointerdown` не мешает протяжке: он ставится на `pointerdown` кнопки, `preventDefault` не нужен.

- [ ] **Шаг 3: ручная проверка в Chrome.** Повторить окружение задачи 5 и проверить:
  - протяжка через 8 строк отмечает 8;
  - протяжка от отмеченной снимает диапазон;
  - у нижнего края список прокручивается и отмечает дальше;
  - после отпускания клик не снимает строку, на которой закончили;
  - клик без движения переключает одну строку.

- [ ] **Шаг 4: проверки и коммит.** `bunx tsc --noEmit -p apps/web` — 0 ошибок, затем:

```bash
git add apps/web/src/ui/chatSelectDrag.ts apps/web/src/ui/Sidebar.tsx apps/web/src/ui/Archive.tsx
git commit -m "feat(web): протяжка мышью в режиме выбора чатов"
```

---

### Задача 7: замер и PR

- [ ] **Шаг 1: замер.** По навыку `relay-perf`, prod-сборка ветки, «Анна Смирнова» (500 чатов), CPU ×4. Записать:
  - вход в режим и выход — длинные задачи и LoAF;
  - протяжка через 30 строк — p95 кадра;
  - прокрутка в режиме на 40 шагов — p95 кадра.

  Цель: нет кадров длиннее 50 мс, p95 при прокрутке не хуже, чем без режима (9 мс по базовому замеру).

- [ ] **Шаг 2: полный прогон.** `bun test apps/web packages/relay-ui` и `bunx tsc --noEmit -p apps/web` — зелёные.

- [ ] **Шаг 3: PR.** Запушить ветку `feat/chat-multiselect`, открыть PR в `master`. Описание на русском:
  - что умеет режим;
  - правила меню (таблица);
  - замеры;
  - скриншоты.

  Последняя строка описания: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Вливать только по слову пользователя (`gh pr merge --merge`).

## Вне плана (отдельно, если понадобится)

- **Перетаскивание закреплённых в режиме выбора** (в tweb оно есть). В Relay порядок закреплённых — по времени закрепления, поэтому сначала нужна операция «задать порядок» в движке и на сервере.
- **Выбор на тач-экране.** Сейчас долгое нажатие открывает меню строки, а «Выбрать» включает режим, после чего тап отмечает строку — это уже работает. Отдельный жест «долгое нажатие сразу отмечает», как в Android, — по запросу.
- **Добавить выбранные в папку.**
