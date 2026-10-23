# План: журнал на чат для групп (финал, 6 кругов адверсального ревью) (часть 1 спека `docs/superpowers/specs/2026-10-23-chat-journal-design.md`)

Учтены замечания шести кругов ревью (`.adversarial-review/bvio-ytbf-eyvr/review_v1..v6.md`). Из v6 дополнительно:
`store.setFlags` сравнивает и `archivedAtId`; `setChatFlags` пишет `chatFlags` в журнал и при сдвиге только границы;
оверлей `unarchive:` берёт `unreadMark` из текущего чата и `pinned = false`, `retouchFlags` учитывает ключ `unarchive:`;
в спек: закреп/отметка в архиве с другого устройства двигают границу и могут отменить снятие архива; подавление
`unarchive` при стоящей ручной `flags:` означает «ручное действие в очереди побеждает, сообщение после него архив не
снимет до следующего события». Изменения v6 относительно v5: `archivedAtId` входит в `chatFlags`, `ChatSummary` и ответы
`setChatFlags`/`unarchive`; граница сдвигается при **каждой** записи с `archived = true`; на клиенте снятие архива —
оптимистичный оверлей по ключу `unarchive:<chatId>`, а в стор пишется только ответ сервера (`opDone` применяет флаги из
ответа, в том числе при `changed: false`). Изменения v5 относительно v4: разархивирование группы — **условная серверная операция**
`unarchive {chatId, messageId}` с границей `archived_at_id`: повтор старых событий через `syncChat` или отложенная
очередь больше не вытаскивают чат из архива; `flushJournals` повторяемый и вызывается из `selfSeq`; убран остаток v3 в
шаге 7; `userSocketSet` чистится синхронно. Изменения v4 относительно v3: **производный архив убран** (ломал глушение, закреп и повторную
архивацию) — возвращаемся к решению спека: личные чаты разархивирует сервер как сейчас, группы — клиент по событию
журнала; ранний `flushJournals` там, где код читает свой `seq` внутри транзакции; подписки сокета и `chatSeq` — по
замечаниям. Изменения v3 относительно v2 (сохранены):
- **Оба журнала пишутся при коммите** одним запросом каждый, в фиксированном порядке «чат → личный». Это снимает
  хрупкий порядок хуков, даёт `membership.seq` на момент коммита и один порядок замков для всех транзакций.
- **Нет постоянного `stale`.** Push применяется к любому чату, открыт он или нет; буфер дыры и `syncChat` — единственные
  способы догнать; `resetChat` — только `chatTooLong`, откат базы и личный `tooLong`. Список не замирает.
- NOTIFY несёт **все события транзакции** (`e: Update[]`), пока влезает; иначе `syncChat`, а не сброс.
- Push во время `syncChat` буферизуется; после ответа применяется цепочка из буфера; `again` только при дыре.
- `typing` групп — через шину Valkey по топику чата; блокировки фильтрует клиент.
- Незнакомый чат из push/`hello` подтягивается строкой; скрытая история защищена и на клиенте (`historyFrom`).

## Цель и подход

Как в v2: событие группы — одна запись в `chat_updates`, одна рассылка `publish('chat:<id>')`; личные чаты без изменений;
клиент держит `chatSeq[chatId]`, на `hello` шлёт `since`. Каналы, упоминания, «кто прочитал» — часть 2.

## Шаги

### 1. Миграция `144_chat_journal.sql`

```sql
create table chat_seq (chat_id bigint primary key references chats(id) on delete cascade, seq bigint not null default 0, updated_at timestamptz not null default clock_timestamp());
create table chat_updates (chat_id bigint not null references chats(id) on delete cascade, seq bigint not null, type text not null, payload jsonb not null, primary key (chat_id, seq));
insert into chat_seq (chat_id) select id from chats where kind <> 'direct';
```
Без индекса по `updated_at` (горячая строка, HOT). `createChat`/`createGroup` вставляют строку `chat_seq`.

### 2. `db.ts`: хук перед коммитом

`beginWithHooks` уже оборачивает `cb`. Добавить `beforeCommit(tx, fn)`: в `wrapped` после `cb` — `for (h of pre) await h()`,
затем `commit`. Исключение в хуке → откат, как любое исключение в `cb`. Не транзакция (`sql`) → `beforeCommit` **бросает**.
`chatEvent` вне транзакции — тоже исключение (в `src` таких вызовов нет; `appendUpdates` вне транзакции сохраняет
нынешний немедленный путь для тестов).

### 3. Журналы пишутся при коммите: `journal.ts` + `chatJournal.ts`

Один объект на транзакцию `perTx: WeakMap<tx, { chats: Map<chatId, Update[]>; users: Entry[]; memberships: …; flushed? }>`
и **один** `beforeCommit`-хук `flushJournals(tx)`, регистрируемый при первом обращении (порядок регистрации неважен):

1. **Журналы чатов** по возрастанию `chat_id`, для каждого один запрос:
   ```sql
   with s as (insert into chat_seq (chat_id, seq, updated_at) values ($1, $n, clock_timestamp())
              on conflict (chat_id) do update set seq = chat_seq.seq + $n, updated_at = clock_timestamp() returning seq)
   insert into chat_updates (chat_id, seq, type, payload)
   select $1, s.seq - $n + t.ord, t.type, t.payload::jsonb from s, unnest($types, $payloads) with ordinality t(type, payload, ord)
   returning seq
   ```
   Результат `{ from: to − n, to }` на чат.
2. **`membership`** новичкам: `seq = to` их чата из п. 1 (или текущий `chat_seq`, если событий чата в транзакции не было —
   `select seq from chat_seq` под уже взятым замком `chats`). Добавляются к личным записям.
3. **Личный журнал** — нынешний `appendUpdates` одним запросом (`user_seq` по возрастанию).
4. `onCommit`: один `pg_notify('chat_updates', { c, f, t, e?: Update[] })` на чат (`e` — все события, если JSON ≤ 7800
   байт, иначе без `e`), затем `pg_notify('updates', …)` личного журнала (`notifyPayloads`, объектный формат всегда:
   `{ p, u, e?, s?, x? }`, части по 7800 байт, `s`/`x` делятся вместе с `p`; `realtime.ts` принимает и старый массив).

**Порядок замков один для всех транзакций: `chat_seq` (по возрастанию `chat_id`) → `user_seq` (по возрастанию `user_id`).**
Все журнальные записи происходят только в `flushJournals`, поэтому никакой код не может взять `user_seq` раньше `chat_seq`.
Замки живут от `flushJournals` до коммита — `clearDraft`, `enqueue`, `exchangeProfiles` идут до него и замков журналов не держат.
Транзакции, меняющие состав, по-прежнему берут `for update` строки `chats` (`groupCtx(…, { lock: true })`) — они
сериализованы между собой.

API:
- `chatEvent(tx, chatId, update, kind)` — `kind` передаётся везде, где известен (`groupCtx`, строка чата); без него —
  `select kind`. `direct` → буфер личного журнала для `membersOf(tx, chatId)`; иначе → буфер чата.
- `appendUpdates(tx, entries)` — теперь кладёт в буфер (возвращает `void`; `seq` известны в `flushJournals`).
  Код, который читает свой `seq` внутри транзакции (`selfSeq(tx)` в `profile.ts:209-210`, `contacts.ts:105,163,219,235`),
  получает его из `selfSeq(tx)`, который сам вызывает `await flushJournals(tx)` (так покрыты и `settings.ts:62,97,114,133`).
  `flushJournals` **повторяемый**: пишет накопленное и очищает буферы; хук перед коммитом пишет то, что добавили после.
  Порядок замков сохраняется правилом: `chatEvent` после того, как в этой транзакции уже писался личный журнал, —
  исключение (в транзакциях с `selfSeq` событий чата нет). Тест `journal.test.ts:122` переписать на чтение через `getUpdates`.
- `membershipEvent(tx, userId, chatId, me)` — отложенная личная запись с `seq` из п. 2.
- `getChatUpdates(userId, chatId, since, limit)`: `assertMember` + `history_from`; ссылки на сообщения с
  `id < history_from` → `messageDeleted`; `tooLong` как у личного.
- `chatSeqsSince(userId, sinceMs)`: `select cs.chat_id, cs.seq, clock_timestamp() … where cm.user_id = $1 and c.kind <> 'direct'
  and cs.updated_at > to_timestamp($2/1000) - interval '5 seconds'`; `now` — из того же запроса.

### 4. Перевод записей групп

Все `fanOut(tx, membersOf/members, …)` по чату → `chatEvent`: `messages.ts:133,157`, `messageOps.ts:42,60,88,102`,
`pins.ts:19`, `todo.ts:33,38`, `jobs/video.ts:211` (несколько чатов), `groups.ts:39`, `chats.ts:51`.
`service.ts`/`login.ts` — личные служебные чаты, без изменений.

- `groupRights.ts`: `members` → `chatEvent` одной записью; `groupUpdated` → `chatEvent` **без `requests`**; клиент не
  трогает `group.requests` по `groupUpdated`. Счётчик заявок — личное `joinRequests { chatId, requests }` одобряющим:
  при новой заявке (`invites.ts`), при решении (`decideRequests`), при смене прав (`setGroupAdmin`/`makeOwner`/
  `setGroupRights`: новому одобряющему — текущее число, снятому — 0). `membership` (без `seq`, при смене прав) и
  `userUpdated` — личные, как сейчас.
- `reads.ts` `markRead`: `readOwn` себе; `readBy` в личном чате — как сейчас; в группе — личным событием **только
  авторам** сообщений в `(old, upToId]` (`select distinct sender_id … where chat_id and id > old and id <= upTo and sender_id <> me`).
  `listChats` для групп: `peer_read_up_to = max(last_read_id)` других участников (смысл `readBy` — «кто-то прочитал»,
  `applyPeerRead` берёт максимум); для личных — `min`, как сейчас. **Отступление от спека («в группах `readBy` нет»)
  записать в спек**: стоимость ограничена числом прочитанных сообщений, не участников.
- `unarchiveOnMessage` — только для `direct` (шаг 9).

### 5. Членство

Вступление (`createGroup`, `addGroupMembers`, `acceptMember`, вход по ссылке): события чата (служебное `newMessage`,
`members`, `groupUpdated`) через `chatEvent`; каждому новичку — `membershipEvent` (одна пачка на всех). Уведомление
личного журнала несёт `s: [[userId, chatId]]`; исключение/выход — `chatRemoved` + `x`. `history_from` новичка
пишется как сейчас.

### 6. Протокол

Клиент → сервер (`parseClientFrame`): `hello { lastSeq, since? }` (необязательный, по умолчанию 0);
`syncChat { reqId, chatId, since }`; `chatsSince { since }`.

Сервер → клиент: `hello { seq, epoch, now, chats: [chatId, seq][] }`; `chats { now, items }`;
`chatUpdates { reqId, chatId, from, to, items, more }`; `chatTooLong { reqId, chatId, seq }`; `chatGone { reqId, chatId }`;
`err` с `reqId` для прочих; `push { chatId?, from, to, items }` — `from` = номер **до** первой записи, `items` может быть
пустым («догони чат»). `ChatSummary.seq` (0 у личных). `MyMembership.historyFrom` (если ещё нет).

### 7. `ws.ts`, `http.ts`, `realtime.ts`

- `http.ts` `open(ws)`: сокет синхронно в `userSocketSet: Map<userId, Set<ws>>`; `ws.data.chats: Set<number>` — наш
  список подписок (Bun не даёт перечислить); `select chat_id … where cm.user_id = $1 and c.kind <> 'direct'` →
  `ws.subscribe('chat:<id>')` + `bus.listen('chat:<id>')` (счётчик ссылок в `bus.ts`; перед `listen` — `!ws.data.chats.has(id)`,
  чтобы не подписаться дважды) — всё в `ws.data.opened`. Привязанный к устройству сеанс подписывается на чаты только
  после `prove` (до него кадры с текстами в `e` уходить не должны). `close`: `bus.unlisten` по `ws.data.chats` **после**
  `opened` (иначе счётчик утечёт); из `userSocketSet` сокет удаляется синхронно в `close`. Экспорт
  `subscribeUserSockets(userId, chatId)` / `unsubscribeUserSockets` (обновляют `ws.data.chats`).
- `ws.ts`: `handleFrame` получает `opened: Promise` параметром; `hello` отвечает **после** `opened` (ожидание не дольше 5 с:
  Valkey недоступен — отвечаем, страховка — сверка на `chatsSince`); ответ:
  `currentSeq`, `epoch`, `chatSeqsSince(userId, since)`; заодно сверка `ws.data.chats` с `chat_members` (подписать
  недостающие, отписать лишние — страховка потерянного `x`). `chatsSince` → `chats` + та же сверка. `syncChat` →
  `getChatUpdates` → `chatUpdates`/`chatTooLong`/`chatGone` (не участник/нет чата).
  `typing`: личный чат — как сейчас (проверка членства и блокировки, поштучно); группа — проверка членства и
  `bus.publish('chat:<id>', frame)`; `deliver` шины → `server.publish('chat:<id>')`. Клиент игнорирует свой `userId`
  и заблокированных (список блокировок у движка есть — `blocks`).
- `listChats`/`listChatsPage`: `left join chat_seq` → `coalesce(cs.seq, 0) as seq`.
- `realtime.ts`: `sql.listen('chat_updates')` → `server.publish('chat:'+c, { op: 'push', chatId: c, from: f, to: t,
  items: e ? e.map((u, i) => ({ seq: f + 1 + i, update: u })) : [] })`. В обработчике `updates`: `s`/`x`.

### 8. Движок: состояние и протокол

**Хранится** (`schema.ts`: хранилище `chatSeq { keyPath: 'chatId' }`, `SCHEMA_VERSION` 4 → 5 **и** условие стирания
`oldVersion < 5`; `meta.since`): `chatSeq[chatId] = seq`. Только номер — никакого `stale`.

**В памяти** на чат: `{ syncing, buffer: Map<from, PushFrame>, gapTimer, again, inFlightReqId }`. Чистится в
`removeChat`, `resetChat`, `wipe`, при обрыве сокета (буфер и таймеры). `removeChat` удаляет и сохранённый `chatSeq`
(повторное вступление — чат «незнакомый», `seq` из `membership`). `chatSeq` и сообщения пишутся одной IDB-транзакцией `flush`.

**Правила `push` с `chatId`** — одинаковые для открытого и закрытого чата:
- чата нет в `chatSeq` → `refreshRows([chatId])` (не чаще раза в 10 с на чат); строка принесёт `seq`;
- `from === seq` и не `syncing` → применить все `items` (`patchedChats` → `loadChatMessages`, как в `syncLoop`: правка
  в закрытом чате иначе потеряется в кэше), `seq = to`, `flush`, `changed`; затем применить из буфера цепочку от нового `seq`;
- `from > seq` → в буфер; если `gapTimer` не идёт — запустить (700 мс); по срабатыванию → `runSyncChat`;
- `from < seq` → игнор; пустые `items` → `runSyncChat` сразу;
- `syncing` → в буфер (без таймера).
Буфер ограничен (200 кадров / 10 с): переполнение → `runSyncChat`.

**`runSyncChat(chatId)`**: `syncChat { reqId }`; ожидание по `reqId` (5 с, 3 повтора, затем сдаться до следующего
push/`hello` — **без** `transport.drop()`); не больше 4 одновременно, очередь: открытые и верхние 20 — вперёд.
`chatUpdates`: применить `items` с `seq > local`, `seq = to`, `flush`; `more` → ещё; затем применить цепочку из буфера от
`to`; `again` (ещё круг) **только** если в буфере остался кадр с `from > seq`. `chatTooLong` → `resetChat` (сообщения,
окно, `loaded`, `snapLast` чата; строка остаётся), `seq = f.seq`, открыт → `ensureWindow` заново. `chatGone` → `removeChat`.
Ответ с `resetGen` старее текущего — отбросить.

**Строка списка** (`applyChats`): чата нет в `chatSeq` → `seq = summary.seq`; `summary.seq > local` → `runSyncChat`
(очередью; лента в кэше остаётся, push применяются после догонки); `summary.seq < local` → откат базы → `resetChat` +
`seq = summary.seq`. Строку из `refreshRows` применять только если `summary.seq >= local` (не откатывать `unread`/`last`).

**`refreshRows(ids)`** — новый метод: дедупликация, дебаунс 300 мс, ≤ 500 id в запросе, не больше одного запроса в
полёте (остальное копится), `GET /chats?ids=…` → `applyChats`.

**`hello`**: `{ op: 'hello', lastSeq, since: store.since }` (`since: 0` после `resetLocal`/`wipe`). Ответ `chats`: для каждого
`[chatId, seq]` — незнакомый → `refreshRows`; `seq <= local` → ничего; иначе `runSyncChat` (открытые и верхние — вперёд,
остальные тем же механизмом в фоне, 4 одновременно). `now` → `since` записывается в `meta` только когда личный
`syncLoop` дошёл до конца **и** очередь `syncChat` пуста. **Личный `tooLong`** (`resetForSnapshot`) чистит `chatSeq` и `since`
(ленты групп там стираются; `seq` возьмутся из строк снимка). `pendingSnapshots()` личного цикла не включает группы;
`snapLast` группы разрешает `runSyncChat`/`resetChat`.

**`membership`** по незнакомому чату: `chatSeq[chatId] = u.seq`, `refreshRows([chatId])`. По знакомому — как сейчас
(`chat.me = u.me`), `seq` игнорируется. `chatRemoved` — как сейчас.

**Скрытая история на клиенте**: `newMessage`/события по сообщению с `id < chat.me.historyFrom` игнорируются (страховка на
случай подписки, пережившей выход).

**Сверочный таймер 90 с**: `runSync` + `chatsSince { since }`.

### 9. Разархивирование групп — условная операция

Сервер хранит `archived` как сейчас; `unarchiveOnMessage` — только для `direct`. Новая колонка
`chat_members.archived_at_id bigint not null default 0` — `max(id)` сообщений чата на момент архивирования
(`select max(id) from messages where chat_id = $1`, по PK назад). Ставится в `setChatFlags` при **каждой** записи с
`archived = true`, не только на переходе (повторная архивация, ушедшая из очереди раньше стоящего `unarchive`, должна
сдвинуть границу). Миграция заполняет для уже архивных — пачками по 1000 строк. Гонка с незакоммиченным сообщением
(id меньше `max`, коммит позже): такое сообщение архив не снимет — допустимо, в спек.

`archivedAtId` добавляется в `ChatSummary`, в событие `chatFlags` и в ответы `PUT /chats/:id/flags` и `/unarchive`
(ответ — всегда полные текущие флаги `{ archived, pinnedAt, unreadMark, archivedAtId, changed }`).

Операция `POST /chats/:id/unarchive { messageId }`: снимает архив **только если** строка `archived`, `messageId >
archived_at_id`, сообщение есть в чате, `sender_id <> me`, чат не заглушён на момент операции; снятие — тот же путь, что
ручное (`setChatFlags`: `pinned_at = null`, `chatFlags` другим устройствам, `PIN_LIMIT`). Иначе `changed: false` с
текущими флагами. `setChatFlags`, `chatNotify`, `countChats`, папка «Архив» не меняются.

Клиент: правило живёт **в пути журнала чата** (`applyChatEntries` для `push`/`syncChat`), не в общем `applyUpdate` и не
на строках списка/снимке: чат уже есть в кэше (проверка до `ensureChat`), `kind !== 'direct'`, `archived`, не заглушён,
`senderId !== me`, `id > archivedAtId` → операция `unarchive { chatId, messageId }` с ключом `unarchive:<chatId>` (тело —
только `messageId`). Пока она в очереди, чат показывается вне архива через **оверлей** (`flagsOverlay` учитывает ключ
`unarchive:`, в том числе для папок и счётчиков) — в стор ничего не пишется. `opDone` для `unarchive:` применяет флаги
из ответа через `store.setFlags` (и при `changed: false` — тогда оверлей снимается и чат остаётся в архиве; 4xx — то же).
`chatFlags` из журнала обновляет `archivedAtId` в сторе. Если в очереди уже стоит ручная `flags:` по этому чату —
`unarchive` не ставится (ручное действие новее). Повтор старых событий и отложенная очередь архив не трогают: сервер
сравнивает с границей, клиент применяет только ответ. Глушение проверяется на момент операции (в спек). Ограничение
«все устройства офлайн — до открытия» остаётся, но сужается: на первом `syncChat` операция уйдёт.

### 10. Нагрузочный инструмент

`tools/load/run.ts`: `hello { lastSeq, since: 0 }`; `chatSeq` на чат; `push` с `chatId` → `from === chatSeq` или буфер/
`syncChat { reqId }`; `chatUpdates` → применить; счётчики `pushed`/`syncs`/`gaps`. `OFFLINE` (участники без сокетов) — часть 2.

### 11. Тесты

**Сервер.** `chatJournal.test.ts`: транзакция с 3 событиями → `from/to`, `seq` подряд, NOTIFY с `e` из трёх; откат — без
дыры и без NOTIFY; два чата в одной транзакции — по возрастанию `chat_id`; `getChatUpdates` пачки/`more`/`tooLong`;
`history_from` → `messageDeleted`; `chatEvent` по виду чата; `notifyPayloads` `s`/`x` частями; `chatEvent` вне транзакции
бросает. e2e: группа из 3 — B и C получают одинаковый `push`; B офлайн, 3 сообщения, `hello {since}` → `[chatId, seq]`,
`syncChat` отдаёт три; `markRead` в группе → `readBy` авторам; вступление: `membership.seq` = `seq` после событий
вступления, новичок получает следующий `push` без `syncChat`; исключение → `chatRemoved`, `push` больше не приходит,
`syncChat` → `chatGone`; `typing` в группе доходит через два процесса (`multiprocess.test.ts`), отправителю — нет (клиент);
архив: `unarchive` с `messageId > archived_at_id` снимает архив и `pinned_at`; с `messageId <= archived_at_id`, своим сообщением или
в заглушённом — `changed: false`; повторная архивация после разархивирования по M и повтор `unarchive {M}` — чат остаётся в архиве;
запись `archived = true` поверх архивного сдвигает `archived_at_id`.
Правка существующих: хелпер `chatEvents(chatId)` (читает `chat_updates` + `hydrate`) вместо `getUpdates` в тестах
групповых событий — отдельный первый коммит.

**Движок.** `chatJournal.test.ts`: `chatSeq` переживает перезапуск; push в закрытый чат применяется и двигает строку;
буфер дыры (push 6 раньше 5 → оба применены, `syncs = 0`); дыра без восполнения → `syncChat`, лента цела; push во время
`syncChat` → применён из буфера после ответа, без второго круга; `chatTooLong` сбрасывает только этот чат; откат базы →
чат живой; личный `tooLong` чистит `chatSeq`; `membership` незнакомого чата заводит его; push по незнакомому чату
поднимает его в список; архив группы снимается по `push` через оверлей и ответ сервера, не снимается по строке списка, снимку и в заглушённом;
`syncChat`, воспроизводящий сообщение старее архивации (второе устройство), — после `changed: false` чат локально в архиве;
ручная `flags:` в очереди подавляет `unarchive`; `since` не уезжает при
обрыве догонки; `settleSnapshots` не создаёт дыр в группах; события с `id < historyFrom` игнорируются.

**Нагрузка**: `GROUP=50 RATE=150`; `GROUP=3000 RATE=10/20/50`. Критерий: 3000 держит ≥ 50/с, `syncs ≈ 0` после прогрева,
p99 доставки при 10/с ≤ 300 мс.

### 12. Документация

`ARCHITECTURE.md`: два журнала, запись при коммите и порядок замков, диаграмма группы, кадры, доставка, остаточные O(N).
Спек: отразить решения v3–v5 (`readBy` авторам, `joinRequests`, условное разархивирование групп и его ограничение,
глушение на момент операции, буфер дыры, `typing` через шину).

## Что остаётся O(N) на событие (сознательно)

- `push.message`: подписки всех участников — фоновая задача; пачки — часть 2.
- Строка `listChats` группы: `count(*)` и `max(last_read_id)` — при чтении списка, не на сообщение.
- `setGroupRights` → `membership` каждому; вступление → `exchangeProfiles`; операции администратора.
- Подписка сокета при открытии — по числу групп пользователя, один запрос + `bus.listen` на группу.
- Запись в базу на сообщение в группу — O(1): `messages` + `chat_updates`/`chat_seq` + задачи; ничего на участника.
  Личные чаты: `unarchiveOnMessage` остаётся (2 строки).

## Порядок коммитов

1. Хелпер `chatEvents` + перевод ожиданий существующих тестов.
2. Миграция, `beforeCommit`, `flushJournals` (оба журнала при коммите, пока без изменения поведения снаружи) + тесты.
3. `chatEvent` и перевод записей; `readBy` авторам; `joinRequests`; членство с `seq`; `s`/`x`; `unarchiveOnMessage`
   только `direct`; `archived_at_id` + `POST /chats/:id/unarchive` + серверные тесты.
4. Протокол, `ws.ts`/`http.ts`/`realtime.ts`, подписки, `typing` через шину + e2e/multiprocess.
5. Движок: схема/`upgrade`, `chatSeq`, буфер дыры, `syncChat`, `refreshRows`, `membership`, архив, `settleSnapshots`,
   `historyFrom` + тесты движка.
6. Нагрузочный инструмент, замеры, документация.

Коммиты 3–5 — одной веткой: между ними клиент групп не обновляется.

## Крайние случаи

- Транзакция с событиями чата и личными: один NOTIFY чата с `e[]`, один личный; порядок между ними неважен.
- NOTIFY разных транзакций одного чата не по порядку: буфер 700 мс; если недостающий не пришёл — `syncChat`.
- Несколько событий чата в транзакции (вступление, чек-лист, закреп): один push со всеми; не влезло — `syncChat`
  (чтение по PK, лента цела).
- Push опередил `ack` у отправителя: сопоставление по `clientId`.
- Исключён между коммитом и publish: лишний push → события с `id < historyFrom` или `syncChat` → `chatGone`.
- Потерян `x`/сокет открылся параллельно с исключением: сверка подписок на `hello`/`chatsSince`.
- Подрезка журнала чата — не в этой части; `tooLong` работает на пустом журнале.
- `since` мусор/будущее → `least(since, now)`; `since = 0` → все группы.
- Пересоздание базы: `wipe` чистит `chatSeq`/`since`; повтор id ловится `summary.seq < local`.
- Движок перезапущен с полным буфером — буфер в памяти, после `hello` чат догонится по `since`.

## Зависимости

Новых нет.
