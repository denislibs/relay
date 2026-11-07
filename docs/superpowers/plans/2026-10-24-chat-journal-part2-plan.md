# План (финал, 5 итераций адверсиального ревью): часть 2 журнала на чат — каналы, комментарии, упоминания, «кто прочитал», push пачками

Заметки реализации из рецензии v5 (не блокирующие, учесть при исполнении):
- Исключение подписчиков канала в `push.message` группы — через `not exists`, не `not in`; к курсору добавить
  `and m.user_id >= $after_uid`, чтобы страница шла по индексу `chat_members`.
- `pg_notify('jobs')` — только после коммита транзакции страницы (не при откате).
- Массовая вставка `push.deliver` — с `on conflict (dedupe_key) do nothing`, как в `enqueue`.
- `withCopy` — только на пути «не дубль»; в `applyLinkPreview` для копии отдельный `updateContent` + событие
  `linkPreview` в журнал группы; пост, созданный до привязки группы, покрыть тестом (копии нет).
- Очередь публикации в `realtime.ts`: `.catch` в цепочке на чат, быстрый путь (есть `e`, очередь пуста) остаётся
  синхронным; сортировка по `seq` не нужна — порядок даёт `chat_seq`.
- `USERNAME` перенести из `apps/server/src/domain/profile.ts` в `protocol`.
- Крайний случай: канал замьючен, группа нет — уведомления о посте не будет (копия пропускает подписчиков канала).

Изменения относительно v4 — по рецензии v4 (2 критических):
- `client_id` копии — `crypto.randomUUID()` (колонка `uuid`); копия находится через `message_threads.copy_id`
  (и `messages_origin` для правок).
- `push.message` одной транзакцией: `delete … where id = $id and attempts = $attempts` с откатом, если строка не
  удалена (аренда перехвачена); курсор — `(user_id, endpoint)` по первичному ключу (`push_subscriptions` без `id`);
  явный `pg_notify('jobs')` после массовой вставки доставок.
- Копия не расходится с постом: `applyLinkPreview`, чек-листы, кнопки, правки, удаление — по `origin` в той же
  транзакции. Автору `readOwn` и в группе. Одно push на пост тому, кто состоит и в канале, и в группе
  (`push.message` группы пропускает получателей-подписчиков канала для копии). Regex упоминаний — ширина
  `USERNAME`, левая граница исключает `./`. Очередь публикации — порядок по `seq`, чистка карты. Текст шага 7
  исправлен. Задержка коалесценции на тихом канале — честно до ~6 с (опрос воркера раз в 5 с); принято.

Изменения относительно v3 — по рецензии v3 (3 критических):
- **Копия поста** — не `kind = 'post'` (`kind` — вид содержимого), а обычное сообщение группы с `origin` и
  `post = true`: своё `client_id` (`copy:<channel>:<post>`), содержимое **перешифровано ключом группы**, `kind`
  оригинала. Push группы для копии — заголовок канала без имени; редактирование/пересылка/удаление/упоминания
  копии из группы запрещены (управляется только через пост).
- **Коалесценция** (`reactions.flush`, `replies.flush`): задача ставится с `runAt` = конец секундного окна, ключ по
  `clock_timestamp()` после замка строки, обработчик читает счётчики под `for share` той же строки — ни «чаще
  раза в секунду», ни потерь.
- **`push.message`**: вставка доставок страницы, постановка продолжения и удаление текущей задачи — одной
  транзакцией; `Topic` не нужен. Страницы — по `push_subscriptions` подписчиков, а не по `chat_members`.
- Остатки v2 убраны (`toMessage(row, kind)`, ручной `±1` рядом с триггером, `postId` → `copyId`); единый regex
  упоминаний в `protocol`; очередь на чат для публикации длинного события; `deleted_at` в `invites`/поиске/`fileFor`;
  копия в поиске индексируется один раз; `last` в строке списка несёт `post`/`postAuthor`.

Изменения относительно v2 — по рецензии v2 (8 критических):
- **Корень треда — копия поста в группе обсуждения** (как в Telegram): сервер при посте вставляет в группу сообщение
  со ссылкой на оригинал (`origin`); комментарии отвечают на копию, `reply_to_id` не ходит между чатами, медиа
  шапки отдаёт группа. Тред в движке — отрезки на тред (`chat.threads[id]`), заданы продление, сброс и уборка.
- **Анонимность поста — колонкой `messages.post`**, `toMessage` без второго аргумента; пересылка поста — от имени
  канала; `planPush` работает по внутреннему `sender_id`; автору — `readOwn` личным журналом.
- **Реакции канала на чтении** — счётчики и «моя» из отдельного запроса; смена эмодзи переносит счётчик.
- **Коалесцирующие задачи** (`reactions.flush`, `replies.flush`) — `dedupe_key` с секундным окном: изменение во время
  работы задачи попадает в следующее окно. `push.message`: честно — повтор страницы даёт только повторную
  работу, доставки дедуплицированы.
- **Длинный пост** (события не влезли в NOTIFY): процесс дочитывает журнал один раз и публикует полный `push` —
  без `syncChat` от каждого сокета.
- **Упоминания**: правило разбора, лимит 20 адресатов, индекс, одно уведомление на сообщение.
- **Удаление канала** — мягкое (`deleted_at`) и страничная чистка.
- `members_count` — триггером на `chat_members`.
- Push канала — честно O(подписчиков с Web Push) в фоне; сценарий нагрузки с 2000 push-подписками, не 198 000.

Изменения относительно v1 — по рецензии v1 (14 критических):
- **Комментарии — обычные сообщения группы обсуждения** (как в Telegram), видимые и в её ленте, с `thread_id`;
  тред — отфильтрованный вид ленты группы. Ничего не нужно «отсекать» в unread, медиа, поиске, `last`.
- **Комментировать и читать тред могут только участники группы обсуждения**: никаких временных подписок,
  не-участник видит на кнопке число и «Вступить в группу». Отступление от Telegram, снимает всю модель доступа
  не-участника; ослабить можно потом.
- **Канал на 200 000 без O(N) на событие**: реакции — счётчики с коалесцированным событием; в канале нет
  `readBy`, нет служебных сообщений о вступлении, нет `groupUpdated` на вступление, счётчик подписчиков —
  колонка; подписчики не «видят» друг друга (общий чат-канал не делает профили взаимно видимыми); список
  подписчиков — только админам.
- **Пост анонимен**: сервер отдаёт `senderId = 0` (автор — канал) и `post: true`; свой пост не считается
  непрочитанным (сервер поднимает `last_read_id` автора).
- Права: полный список точек, где ветвление по виду чата должно измениться (из ревью), включая `NotifyType`,
  `typing`, вступление по `@имя`, `summaryFromRow`, `normalizeAdminRights`.
- Упоминания — по `@username` в тексте и ответу, без нового типа сущности; ссылка `mention` в журнале с `hydrate`.
- `push.message` пачками с дедупликацией по странице; просмотры — узкая таблица, дедупликация в Valkey, лимит.
- Стек навигации получает `threadId` явно; чтение из треда не читает основную ленту.
- Нагрузка: канал через `createGroup` (есть владелец), `expected` только по онлайн, push-подписки офлайн-пользователей
  — на заглушку push-сервиса.

## Цель

1. **Каналы** (`kind = 'channel'`): пишут админы с правом `post`; создание, настройки, посты без автора,
   просмотры, подписчик без композера.
2. **Комментарии**: тред в связанной группе, кнопка «N комментариев» под постом, непрочитанное треда, открытие
   поверх по стеку.
3. **Упоминания и ответы мне** — личный журнал, бейдж «@».
4. **«Кто прочитал»** по запросу в группах до 100 участников.
5. **`push.message` пачками**.
6. **Нагрузка**: канал 200 000 участников при 2000 онлайн.

## Модель

### Канал

- `chats.kind in ('direct','group','channel')`. `GroupCtx.kind`, `ChatSummary.kind`, `LocalChat.kind` — то же.
- `chats.members_count int` — **триггер** на `chat_members` (after insert/delete: `±1`), покрывает все пути
  (`createChat`, `createGroup`, seed, `service`, `openDirect`, `insertMember`, `dropMember`); строка списка берёт
  его, а не `count(*)`. Для групп тоже (убирает `count(*)` из каждой строки).
- Права канала (`protocol/groups.ts`): `AdminRight` += `'post' | 'edit'`; `ADMIN_RIGHTS_BY_KIND = { group: [info,
  delete, ban, invite, pin, addAdmins], channel: [info, post, edit, delete, ban, invite, addAdmins] }`;
  `normalizeAdminRights(raw, kind)`; `allAdminRights(kind)`. У подписчика `MemberRights` = `noRights()`, кроме
  `reactions: true` (реакции решает настройка чата, не права участника). `canPin(ctx)` = группа: как сейчас;
  канал: `admin?.post`. Владелец канала — `admin = allAdminRights('channel')`.
- `ctxFromRow`: для `channel` — `role` из строки (owner/admin/member), `admin` по роли, `rights` = admin ?
  `allRights()` : `subscriberRights()`; `slowMode` 0; `historyFrom` как есть.
- Guards: `isGroup(ctx)` остаётся для операций только групп (`rights`, `slowMode`, `history_hidden`, `restrict`,
  `rank`, `hide members`); новый `isCommunity(ctx)` (группа или канал) — для `requireAdmin`, info, photo, admins,
  invites, members (чтение — только админам у канала), bans, requests, reactions, username, delete, transfer,
  `setLinkedChat`, `signatures`.
- `GROUP_MEMBERS_MAX` → `MEMBERS_MAX = { group: 5000, channel: 200_000 }`.
- Вступление по `@имя` и ссылке: `invites.ts` ищет `kind in ('group','channel')`; для канала — без служебного
  сообщения, без `groupUpdated`, без `exchangeProfiles`; `membership` новичку (с `seq`) — да; `members` в журнал
  канала не пишется никогда (подписчики не видят состав).
- Профили: `viewersOf`/`canView` не считают канал общим чатом (видят друг друга по личным чатам, группам и
  контактам); `chatMembers`/`listGroupMembers` для канала — только админам; `exchangeProfiles` при вступлении в
  канал не вызывается.
- Уведомления: `NotifyType` += `'channel'` (настройки по умолчанию для каналов; `push.ts` берёт их по виду).
- `typing`: в канале шлёт только админ с `post` (иначе игнор), получатели — все онлайн (это редкие кадры админов).
- Удаление канала (и большой группы) — **мягкое**: `chats.deleted_at`; с этого момента все операции и `syncChat`
  отвечают `chatGone`/`not_found` (проверка `deleted_at is null` в `groupCtx`/`chatSeqOf`/`chatSeqsSince`/списке
  чатов), сокеты отписываются при следующей сверке. Задача `chat.purge {chatId, after}` страницами по 1000:
  `chatRemoved` в личные журналы страницы и `delete from chat_members` этой страницы в одной транзакции,
  продолжение с `after`; затем сообщения страницами по id; в конце строка `chats`. Никакой гигантской транзакции.

### Пост

- Пост = сообщение в канале с колонкой `messages.post = true` (ставится при вставке в канал). Хранит `sender_id`
  (внутренняя правда: права, лог, `planPush`). `toMessage(row)` без новых аргументов: `row.post` → `senderId: 0`,
  `post: true`, `postAuthor` (`messages.post_author` — строка на момент поста, если `chats.signatures`), `views`.
  Гидрация журнала, история, поиск, `last` в строке списка — все через `toMessage`, утечки `sender_id` нет.
- Пересылка поста: `fwdFrom = { chatId: канал, messageId, name: название канала, userId: null, postAuthor? }` —
  автор не раскрывается (как `channel_post` в Telegram).
- `planPush`: исключение автора и блокировки — по `sender_id` строки (не по API-сообщению); заголовок — название
  канала; имя отправителя не подставляется.
- Свой пост не непрочитан: сервер в транзакции поста поднимает `last_read_id` автора и пишет ему `readOwn
  {chatId, upToId: id}` в личный журнал (другие устройства автора снимают +1 от `unreadOnArrival`); на
  отправившем устройстве сообщение приходит с его `clientId` (pending) — `mine` для статуса, вид — пост.
- Правка: своё всегда (по `sender_id`), чужое при `edit`; без лимита времени для админов с `edit`. Удаление: своё
  или `delete`; всегда для всех. Закреп: `post`; без «уведомить всех» (тихий).
- `replyToId` в канале запрещён (`bad_frame`): ответы — только в треде группы.
- Реакции в канале: `message_reaction_counts(chat_id, message_id, emoji, n)` + `message_reactions` (кто что
  поставил — своя реакция). `reactMessage` в канале: под замком строки сообщения — снять старую (`n-1`), поставить
  новую (`n+1`), одной транзакцией; затем задача `reactions.flush`: `w = floor(extract(epoch from clock_timestamp()))` берётся **после** замка
  строки сообщения, `dedupe_key = reactions:<chat>:<msg>:<w>`, `runAt = to_timestamp(w + 1)` (конец окна; `enqueue`
  получает `runAt`, сейчас он ставит `now()`); обработчик берёт `select … for share` той же строки сообщения и
  читает счётчики — любая смена, успевшая до его чтения, уже учтена, более поздняя — под замком получила новый
  `w` и свою задачу. Итого не чаще раза в секунду на пост и без потерь; задача шлёт `chatEvent(channel, { type: 'reactionCounts', chatId, id, counts })`. **Чтение**: для
  канала `withReactions` не вызывается — история и поиск берут `counts` из `message_reaction_counts` и `mine` из
  `message_reactions where user_id = me` (два join'а, O(эмодзи), без списка реакторов); клиент показывает счётчики
  без аватаров. В группах как сейчас.
- `readBy` в канале не пишется вовсе (вместо галочек — просмотры). `markRead` в канале: только `readOwn` + чистка
  упоминаний (их у подписчика не бывает, но путь общий).
- Просмотры: таблица `message_views(chat_id, message_id, views)` (узкая, HOT). `POST /chats/:id/views {ids}`
  (участник канала, ≤ 100 id): Valkey `SADD seen:<user>:<chat> ids` с TTL 24 ч → инкремент только добавленных,
  одним `insert … on conflict do update set views = views + 1`; лимит 1 запрос/с на пользователя (Valkey `INCR` с
  TTL 1 с; превышение — `flood`). Ответ `{views: [[id, n]]}`. История и `push` несут `views` (join). Клиент: по
  одному разу на пост за сессию, батч раз в секунду, только рост.

### Комментарии

- `chats.linked_chat_id` (канал → группа и группа → канал, обе строки). `setLinkedChat(userId, channelId, groupId
  | null)`: владелец канала и админ группы с `info`; замки `chats` обеих строк по возрастанию id; «группа уже
  привязана к другому каналу» — `forbidden`; `history_hidden` группы выключается, включить его у привязанной
  нельзя; `chatEvent(groupUpdated)` обеим. `GET /groups/:id/discussion-candidates` — мои группы (админ с `info`) без
  `linked_chat_id`, не форум.
- **Корень треда — копия поста в группе** (как в Telegram). В транзакции поста, если у канала есть
  `linked_chat_id`, сервер вставляет в группу сообщение с тем же `kind` (вид содержимого — фото/голос/… как у поста),
  `sender_id = автор`, `post = true`, `origin = {chatId: канал, id: пост}` (jsonb), `client_id =
  crypto.randomUUID()` (колонка `uuid`; копия ищется через `message_threads.copy_id`, правки поста находят её по
  индексу `messages_origin`), содержимое **перешифровано ключом
  группы** (`sealContent(groupKey, aad = messages|group|client_id)`, как любое сообщение группы — блоб канала в
  группе не откроется), вложение — ссылкой на тот же объект (`fileFor` отдаёт его участнику группы через это
  сообщение). Копия — обычное сообщение группы: в её ленте (без «переслано», с подписью «канал», `senderId: 0`
  через `post`), в unread, в журнале группы (`newMessage`). Push группы о копии — `planPush` по `post`: заголовок
  «<канал>», без `имя: ` (та же ветка, что у поста в канале). **Из группы копию нельзя** редактировать, удалять,
  пересылать как своё (`fwdFrom` — канал, как у поста), упоминания из её текста не создаются; `messageOps`
  отвечают `forbidden` при `origin is not null`. Поиск индексирует копию один раз (пропуск `origin is not null`
  в индексе группы; находится как пост канала). `message_threads(channel,
  post) ↔ copy_id`. Правка/удаление поста — правка/удаление копии в той же транзакции (`updateContent` по `origin`); то же для
  `applyLinkPreview` (превью снимает `pending` у обеих), чек-листов (`todo`) и кнопок — все пути, что меняют
  `messages` по `(chat_id, id)` поста, делают это и для копии (один помощник `withCopy(tx, channel, postId, fn)`).
  Автору — `readOwn` и для группы (копия не +1 на его других устройствах). Участник и канала, и группы получает
  **одно** push: `push.message` группы для копии пропускает `user_id in (select user_id from chat_members where
  chat_id = канал)`.
  Журналы канала и группы пишутся в одной транзакции `flushJournals` — порядок по `chat_id`, как и сейчас.
- Комментарий — обычное сообщение группы с `messages.thread_id = id копии`. Видно в ленте группы, считается в
  unread, индексируется, в медиа. Ответ внутри треда: `reply_to_id` — сообщение с тем же `thread_id` или сама копия
  (один чат, цитаты и `fileFor` работают как обычно).
- Отправить: `send {chatId: group, threadId: copyId}` — участник группы (`groupCtx`, права группы). Проверка: копия
  существует в группе, `origin is not null`, не удалена.
- `replies` на посте: `message_threads(chat_id, post_id, copy_id, count, last_id, recent bigint[])` (chat_id —
  канал) обновляется в транзакции комментария: `count+1`, `last_id`, `recent = (array_remove(recent, sender) с
  sender впереди)[1:3]`; удаление комментария — пересчёт по `messages_thread`: `count(*)`, `max(id)`, последние 3
  различных `sender_id` по убыванию id. Событие `replies {chatId: канал, id: пост, count, lastId, recent}` в журнал
  канала — задачей `replies.flush` по той же схеме, что `reactions.flush`: `w` по `clock_timestamp()` под замком строки
  `message_threads`, `dedupe_key = replies:<chat>:<post>:<w>`, `runAt = конец окна`, чтение под `for share`.
- Тред: `GET /chats/:group/threads/:copyId/messages?before|after&limit` — участник группы; история — сообщения с
  `thread_id = copyId` плюс сама копия как шапка. Прочитанность треда — `thread_reads(user_id, chat_id, thread_id,
  read_max_id)`; `PUT /chats/:group/threads/:copyId/read {upToId}` → `readThread {chatId, threadId, upToId}` своим
  устройствам; после своего комментария сервер поднимает `thread_reads` автору. На кнопке у поста: `replies.lastId
  > readMaxId` → точка; `readMaxId` и `copyId` приходят в истории канала (`getHistory` для участника — left join
  `message_threads` и `thread_reads`); журнальные `newMessage`/`messageEdited` этих полей не несут и в сторе их не
  затирают. У поста в истории канала: `replies: { copyId, chatId: группа, count, lastId, recent, readMaxId }`.
- Не-участник группы: видит число комментариев и «Вступить в группу, чтобы читать и писать» (если группа
  публичная или по ссылке — вступление как обычно). `join_to_send` не вводим.
- Пост удалён: копия в группе удаляется тоже (та же транзакция), тред остаётся читаемым с шапкой «пост удалён»
  (копия как удалённое сообщение); кнопка у поста пропадает вместе с постом.
- Перепривязка: старые копии и треды остаются в старой группе; кнопки у постов показываются только при совпадении
  `message_threads.chat_id` группы с текущим `linked_chat_id`.
- Упоминания в комментариях: `message_mentions.thread_id`, чистятся чтением треда.
- Поиск: индекс сообщения несёт `threadId`; переход из результата в комментарий открывает тред.

### Упоминания

- При записи сообщения: `MENTION_RE` в `protocol` (один regex с границами, как `RICH_RE`: `(?<![\w@./])@(USERNAME)(?![\w])`, где `USERNAME` — та же ширина, что в `protocol`
  (`medium.com/@name` — не упоминание)), применяется к тексту **вне** `code`-сущностей и `pre`-блоков (`blocks`) и вне `link`-сущностей — тот же
  обходчик, что у `RICH_RE`; через `users.username`; плюс автор `replyToId`. Не больше **20** адресатов на
  сообщение (лишние игнорируются). Только участники чата, не автор, не заблокировавшие автора; в канале — только
  админам с `post`. `insert into message_mentions (user_id, chat_id, message_id, thread_id)` + индекс
  `(chat_id, message_id)` для чистки при удалении. Личная запись `mention {chatId, id, threadId?}` — ссылка
  (`stored`: `{type:'mention', chatId, id, threadId, ref:1}`), `hydrate` подставляет сообщение (как `newMessage`),
  удалённое → `messageDeleted`. Смена username задним числом упоминания не меняет (как в Telegram).
- Одно уведомление на сообщение: в движке `mention` для сообщения, которое уже пришло `newMessage` (или наоборот),
  не показывает второе — ключ `chatId:id` в `notifiedIds`; звук и текст — от `mention`, если он есть.
- `markRead` основной ленты чистит `message_mentions` с `thread_id is null and message_id <= upToId`; чтение треда —
  с этим `thread_id`. Удаление сообщения и выход из чата чистят строки. Строка списка: `unreadMentions =
  count(*)` по PK-префиксу (дёшево), с учётом `history_from` при вставке (не вставляем для `id < history_from` —
  не бывает).
- Web Push для `mention`: отдельная задача `push.mention` — уходит **и в заглушённый чат** (как Telegram: упоминания
  пробивают mute, пока не выключены «упоминания» в настройках — у нас пока всегда).
- Клиент: `chat.mentions` из строки списка и `+1`/сброс по `readOwn`/`readThread`; бейдж «@», звук и системное
  уведомление с телом из `push` личного журнала; кнопка «к упоминанию» — `focusMessage` по `message_mentions`?
  нет: по локальной очереди id упоминаний из журнала (`chat.mentionIds`).

### «Кто прочитал»

`GET /chats/:id/messages/:mid/read-by`: группа, `members_count <= 100`, автор сообщения (иначе `forbidden`), не
для комментариев (`thread_id is null`); ответ `[{id, name}]` — участники с `last_read_id >= mid`, кроме автора.
UI: пункт меню своего сообщения, попап.

### Длинное событие канала

NOTIFY `chat_updates` без `e` (события не влезли в 8000 байт) — процесс **один раз** читает записи журнала чата
`(f, t]` (`getChatUpdatesRange(chatId, from, to)` без пользовательского фильтра, с `hydrate`) и публикует полный
`push` всем своим подписчикам — через очередь на чат в `realtime.ts` (`Map<chatId, Promise>`: одно чтение в полёте на чат,
следующие NOTIFY того же чата — и обычные с `e`, и без — встают за ним и публикуются по `seq`; запись карты
удаляется, когда очередь пуста), чтобы порядок `push` по `seq` сохранялся; скрытую историю фильтрует клиент по `historyFrom` (как сейчас). Ни одного `syncChat`
от сокетов. Применимо и к группам (часть 1 слала пустой `push`; теперь — только если чтение не удалось).

### `push.message` пачками

Задача `push.message {chatId, id, after?}`: страница **`push_subscriptions`** подписчиков чата
(`push_subscriptions join chat_members using (user_id) where chat_id = $1 and (user_id, endpoint) > ($after_uid,
$after_ep) order by user_id, endpoint limit 1000` — первичный ключ `push_subscriptions` — `endpoint`, `id` нет; с
нынешними фильтрами mute/блокировок) → один `onlineUsers` на страницу → в **одной транзакции**: `insert into jobs
… select unnest` задач `push.deliver` (`dedupe_key = push.deliver:<endpoint>:<id>`), `enqueue` продолжения
`{…, after: [lastUid, lastEndpoint]}` (`dedupe_key = push.message:<chat>:<id>:<uid>:<ep>`) если страница полная,
`delete from jobs where id = $id and attempts = $attempts` — если удалено 0 строк, аренду перехватил другой
воркер → `rollback` (ничего не вставлено), затем `pg_notify('jobs')` — массовая вставка идёт мимо `enqueue`, без
него доставки ждали бы опроса (до 5 с). Либо всё, либо ничего: повтор по истёкшей аренде даёт доставки ровно
один раз. Без
`Topic`. Число страниц — по числу подписок, а не участников (канал 200 000 с 2000 подписками — 2 страницы).
Честно: на канале 200 000 это O(подписчиков с Web Push и выключенным mute) задач доставки на пост — фоновая
стоимость уведомлений, не путь отправки; без серверного fan-out у Web Push её не убрать. Упоминания:
`push.message` пропускает получателей, у которых есть `message_mentions` этого сообщения (их уведомит
`push.mention`).

## Шаги

### 1. Миграция `145_channels.sql`

```sql
alter table chats drop constraint chats_kind_check;
alter table chats add constraint chats_kind_check check (kind in ('direct','group','channel'));
alter table chats add column linked_chat_id bigint references chats(id) on delete set null,
                 add column signatures boolean not null default false,
                 add column members_count int not null default 0;
update chats c set members_count = (select count(*) from chat_members m where m.chat_id = c.id);
alter table chats add column deleted_at timestamptz;
alter table messages add column post boolean not null default false, add column post_author text, add column thread_id bigint, add column origin jsonb;
create index messages_thread on messages (chat_id, thread_id, id) where thread_id is not null;
create index messages_origin on messages ((origin->>'chatId'), (origin->>'id')) where origin is not null;
create or replace function chat_members_count() returns trigger … -- ±1 в chats.members_count
create trigger chat_members_count after insert or delete on chat_members for each row execute function chat_members_count();
create table message_views (chat_id bigint, message_id bigint, views int not null default 0, primary key (chat_id, message_id));
create table message_reaction_counts (chat_id bigint, message_id bigint, emoji text, n int not null, primary key (chat_id, message_id, emoji));
create table message_threads (chat_id bigint, post_id bigint, copy_id bigint not null, count int not null default 0, last_id bigint, recent bigint[] not null default '{}', primary key (chat_id, post_id));
create table thread_reads (user_id bigint references users(id) on delete cascade, chat_id bigint references chats(id) on delete cascade, thread_id bigint not null, read_max_id bigint not null default 0, primary key (user_id, chat_id, thread_id));
create table message_mentions (user_id bigint references users(id) on delete cascade, chat_id bigint references chats(id) on delete cascade, message_id bigint not null, thread_id bigint, primary key (user_id, chat_id, message_id));
create index message_mentions_msg on message_mentions (chat_id, message_id);
```
Каскады `on delete cascade` от `chats` для новых таблиц с `chat_id`.

### 2. Сервер: канал (права, создание, управление, подписчики)

- `protocol/groups.ts`: права по виду; `GroupInfo` += `signatures`, `linkedChatId`; `members` — из `members_count`.
- `groupRights.ts`: `ctxFromRow` для канала; `isCommunity`; `canPin`; `normalizeAdminRights(raw, kind)`;
  `viewersOf`/`canView` — без каналов; `broadcastMembers` для канала — только `exchangeProfiles` **не** вызывать
  и `chatEvent(members)` не писать.
- `chats.ts`: `createGroup(creatorId, {kind, title, about?, memberIds?})` — канал без участников; `members_count`;
  `MEMBERS_MAX` по виду; `summaryFromRow` для `kind !== 'direct'`; строка списка: `members_count` вместо
  `count(*)`, для канала без `max(last_read_id)`; `toMessage(row)` по `row.post` — `senderId: 0`, `post`, `postAuthor`,
  `views`; ручная сборка `last` в строке списка (`chats.ts`) несёт `lm.post`/`lm.post_author`.
- `groups.ts`: `members_count` — только триггер (ручного `±1` нет); для канала `acceptMember` без служебного и
  `broadcastGroup`; `setGroupSettings` += `signatures` (канал, `post`), `setLinkedChat`, `discussion-candidates`;
  `deleteGroup` канала — задача `chat.purge` страницами.
- `invites.ts`: `kind in ('group','channel')`, `deleted_at is null` (также в поиске и `fileFor`); `GET /join/+…` для канала — «N подписчиков».
- `messages.ts`: `requireRight` канала = `admin?.post` (`forbidden`); `postAuthor`; `replyToId` запрещён;
  `last_read_id` автора; `threadId` (см. 4).
- `messageOps.ts`: `edit`/`delete`/`pin` по виду; реакции канала — счётчики + `reactions.flush`.
- `reads.ts`: канал — без `readBy`.
- `ws.ts`: `typing` в канале — только `post`.
- `push.ts`: `NotifyType 'channel'`, заголовок — название канала без имени.
- `chats.ts` `getHistory`: `views` и `readMaxId` (для канала, участнику) через left join.

### 3. Сервер: просмотры, упоминания, «кто прочитал», push пачками

- `views.ts`: `countViews(userId, chatId, ids)` с Valkey-дедупом и лимитом; `POST /chats/:id/views`.
- `mentions.ts`: `collectMentions(tx, …)`; вызовы из `sendMessage` (и комментариев); чистка в `markRead`,
  `readThread`, `deleteMessage`, `dropMember`; `unreadMentions` в строке списка; `push.mention`.
- `reads.ts` `readBy(userId, chatId, mid)` + маршрут.
- `push.ts`/`jobs`: пачки с дедупом, продолжение страницами.

### 4. Сервер: комментарии

- `messages.ts`: `threadId` — проверки (копия с `origin` в этой группе, не удалена; `reply_to_id` в
  треде); пост в канал с `linked_chat_id` — вставка копии (перешифровка ключом группы), `message_threads` upsert, `replies.flush` (`dedupe`), `thread_reads` автору.
- `messageOps.ts` `deleteMessage` комментария — пересчёт `message_threads` и `replies.flush`.
- `threads.ts`: `GET /chats/:group/threads/:copyId/messages`, `PUT …/read`.
- Журнал группы несёт комментарии как обычные `newMessage` (с `threadId` в сообщении) — ничего нового.

### 5. Протокол и движок

- `Update` += `replies`, `reactionCounts`, `mention`, `readThread`; `Message` += `post?`, `postAuthor?`, `views?`,
  `threadId?`, `replies?`, `readMaxId?`, `reactionCounts?`; `ClientFrame.send` += `threadId`.
- Движок: `Query` += `{kind: 'thread', chatId: group, threadId: copyId, limit, anchor?}` — сообщения группы с
  `threadId === copyId` плюс копия как шапка, из того же кэша сообщений (`chatMessages` + фильтр). **Отрезки треда**
  — `chat.threads[copyId] = { ranges, seed?, historyStart? }` со своими правилами: страница треда (свой эндпоинт)
  сливается с отрезками треда (`addPage` на `threads[id].ranges`); комментарий из журнала/push (`threadId` в
  сообщении) продлевает **живой отрезок треда** (`extendLive` на `threads[id]`), а основной отрезок группы —
  как любое сообщение группы; `resetChat`/`chatTooLong`/уборка (`evict`): отрезки тредов чата стираются вместе с
  `ranges` (`chat.threads = {}`), тред перезагружается при открытии; `removeChat` — вместе с чатом. Основная лента
  группы показывает копию и комментарии как есть (как Telegram).
- `applyUpdate`: `replies` → патч поста; `reactionCounts` → патч; `mention` → `chat.mentions++`, `mentionIds`,
  уведомление; `readThread` → `threadReads`.
- Действия: `sendMessage {threadId}`, `markThreadRead`, `readBy`, `countViews` (батч 1 с, `seenPosts` в памяти).
- Канал в сторе: `kind: 'channel'`, `subscribers` вместо онлайна, посты `mine = false` для вида (`post: true`),
  `canSend = me.admin?.post`; `typing` не показывается.

### 6. Web

- Создание: «Новый канал» → `NewChannel.tsx` (название, описание, фото) → «Добавить подписчиков» (из
  `NewGroup.tsx`, «Пропустить») → канал открыт.
- Управление (`ui/group/*` по `kind`): скрыть «Права участников», «Скрытая история», «Медленный режим», «Скрыть
  участников»; добавить «Тип канала» (переиспользовать username/ссылки), «Обсуждение» (`Discussion.tsx`),
  «Подписи постов», права админа канала (`Admins.tsx` по `ADMIN_RIGHTS_BY_KIND`), «Подписчики» только админам.
- Лента канала (`Feed.tsx`): пост слева без аватара/имени (`post`), мета: глаз + просмотры, `postAuthor`,
  «изменено», булавка; кнопка «Переслать» справа; без «Ответить»; закреп тихий. Нижняя панель: не участник —
  «Подписаться»/«Запросить»; участник без `post` — «Выключить/Включить звук». Кнопка комментариев
  (`Comments.tsx`): аватары ≤ 3, «N комментариев»/«Оставить комментарий», точка непрочитанного; клик →
  участник группы: `openInner({chatId: group, threadId: copyId})`; не участник — попап «Вступить в группу».
- Тред (`Thread.tsx`): шапка «N комментариев», стрелка назад, плашка с постом (`post: null` → «Пост удалён»),
  лента `Query thread`, композер группы; правая панель остаётся.
- **Стек навигации** (`data.ts`, `docs/navigation-rules.md`): запись стека `{chatId, threadId?}`; `openInner`
  ищет дубль по паре; `openChatId`/`openThreadId` в `global`; позиции прокрутки по ключу `chatId:threadId`;
  `seen()` из треда → `markThreadRead`, а не `seen` основной ленты; `#chat=…&thread=…` при загрузке — нижний слой.
- Упоминания: бейдж «@», кнопка «к упоминанию», звук/уведомление. «Кто прочитал»: пункт меню → попап.
- `Info.tsx`: канал — «N подписчиков», без онлайна; «Участники» только админу.

### 7. Нагрузка

`run.ts`: `KIND=channel` (через `createGroup` с владельцем; постят первые `ADMINS`), `OFFLINE=N` (участники без
сокетов, добавляются через `addGroupMembers` страницами по 1000), `expected` — только по онлайн-получателям,
`PUSH_SINK=K` — первым K офлайн-пользователям регистрируется push-подписка на локальную заглушку (как в
`push.test.ts`). Сценарии: канал 200 000 / 2000 онлайн / 10 постов/с — p99 доставки ≤ 100 мс, отправка O(1) (ack
p50 ≤ 30 мс, не зависит от N); `push.message` с `PUSH_SINK=2000` проходит страницами без истечения аренды
(2 страницы на пост по подпискам); группа 3000 с комментариями 20/с в один тред. Сценарий с push у всех 198 000 не ставим:
это ~2 млн задач доставки на пост, такой трафик без серверного fan-out Web Push невозможен — ограничение
записано в документацию.

### 8. Тесты

Сервер: `channels.test.ts` (создание без участников, права `post`/`edit`/`delete`/`pin`, подписчик
`forbidden`, `senderId 0`/`post`/`postAuthor`, свой пост не непрочитан, `members_count`, подписчики только
админу, вступление без служебного/`groupUpdated`/`members`, `membership` с `seq`, реакции счётчиками и один
`reactionCounts` на секунду, нет `readBy`, `typing` только админа, `NotifyType channel`, удаление страницами);
`views.test.ts` (дедуп, лимиты, только рост); `comments.test.ts` (привязка/отвязка с замками и запретами,
комментарий участником, не-участник `not_member`, `reply_to` только внутри треда, `message_threads` и один
`replies` на секунду, удаление комментария пересчитывает, тред с постом первым и `post: null` после удаления,
`thread_reads` после своего комментария и по `PUT read`, `readThread` своим устройствам, `readMaxId` в истории);
`mentions.test.ts` (по `@username` и ответу, не автору, не заблокировавшему, в треде с `thread_id`, чистка по
`markRead`/`readThread`/удалению/выходу, `unreadMentions`, `push.mention` сквозь mute); `readBy.test.ts`;
`push.test.ts` (страницы, дедуп на повторе аренды). Движок: `channel.test.ts` (пост входящий, `canSend`, просмотры
батчем и только рост, панель подписчика, тред поверх по стеку, `replies`/точка, `markThreadRead` не трогает
основную ленту, `mention` → счётчик, сброс, уведомление; `reactionCounts`). Web: Playwright по чек-листу.

## Порядок коммитов

1. Миграция, протокол, права канала, `members_count`, создание/управление/вступление канала (сервер + тесты).
2. Посты: анонимность, подписи, просмотры, реакции счётчиками, нижняя панель (сервер + движок + web).
3. Комментарии: `thread_id`, `message_threads` + `replies.flush`, `thread_reads`, тред в движке, стек навигации
   с `threadId` (сервер + движок + web).
4. Упоминания и «кто прочитал».
5. `push.message` пачками, `chat.purge`, нагрузка, документация (ARCHITECTURE §3.1, спек).

## Крайние случаи

- Комментарий участником, который в канале не состоит (только в группе): можно — права группы (как в Telegram
  группа может быть шире канала). Группа ограничена 5000 участниками — значит, комментаторов у канала не больше
  5000 (пока нет комментирования без вступления).
- Пост с вложением, канал приватный, группа публичная: копия в группе ссылается на тот же объект файла; доступ
  к файлу — через членство в группе (`fileFor` по сообщению-копии). Это и есть предупреждение при привязке.
- Группа обсуждения приватная, канал публичный: при привязке предупреждение (как в Telegram), запретов нет.
- `history_from` у вступившего в группу позже: тред показывает только комментарии `id >= history_from`;
  `message_threads.count` общий — число на кнопке может быть больше видимого (как в Telegram).
- Замки при комментарии: `chat_seq` группы (по `flushJournals`) и строка `message_threads` канала; события в
  журнал канала не пишутся в транзакции комментария (их пишет `replies.flush`) — замок `chat_seq` канала не берётся.
- Пост отредактирован/удалён: события канала как обычно; `message_threads` остаётся.
- Просмотры по превью публичного канала без вступления — вне плана (превью тоже).

## Вне плана

Превью и чтение публичного канала без вступления; комментарии без вступления в группу (`join_to_send` в обе
стороны); статистика, бусты, сторис, стримы, автоперевод, send-as, служебный чат «Replies»; Web Push `Topic`.
