# Доставка кодов входа

Код входа (5 цифр, 5 минут), код регистрации нового номера и код восстановления пароля (6 цифр, 10 минут)
уходят каналом `CODE_DELIVERY` — `apps/server/src/domain/codeDelivery.ts` (настройка — `codeChannel.ts`).

| `CODE_DELIVERY` | Куда | Где можно |
|---|---|---|
| `dev` | код в ответе `/auth/code` (`devCode`), письма восстановления — `/dev/codes` | dev, тесты (по умолчанию при `DEV_LOGIN=1`) |
| `log` | строка с кодом в лог `server`/`worker` | dev (по умолчанию при `LOG_LOGIN_CODES=1`) |
| `telegram` | бот пишет код в чат владельца, он передаёт код человеку сам; номер, подтверждённый через «Войти через Telegram», получает код от бота сам | production |
| не задан | код только в служебном чате на устройствах, где аккаунт уже открыт; новый номер не зарегистрировать | — |

Служебный чат работает при любом канале: у кого есть открытый сеанс, получает код там, и владельцу в Telegram
такой код не уходит. Владельцу приходят только коды, которые иначе доставить некуда: регистрация нового номера,
вход в аккаунт без открытых сеансов, восстановление пароля.

Как устроено:
- канал «доставляет» (`dev`, `log`, `telegram`) — сервер хранит настоящий хэш кода и для аккаунта без сеансов,
  и для нового номера; без канала хэш неугадываемый (ответ всё равно одинаковый — существование аккаунта не видно);
- `telegram` идёт через очередь задач (`code.deliver`, восстановление — `mail.recovery`): задача ставится в той же
  транзакции, что и код, и уходит после коммита. Сбой Telegram не держит запрос входа: 429, 5xx и сеть — повтор
  (6 попыток, 1→2→4→8→16 с), прочее (неверный токен, бот заблокирован) — сразу в `jobs_dead`. Код лежит в
  `payload.secret` и в `jobs_dead` не копируется; истёкший к моменту отправки код не шлётся;
- лимиты те же: 30 запросов кода в час с адреса, 5 в час на логин и на аккаунт, 15 неверных кодов в час;
- **дневной потолок** бота — `TELEGRAM_DAILY_CAP` (по умолчанию 300 сообщений за сутки UTC, таблица
  `code_deliveries`): на 80 % — предупреждение в логе, сверх потолка код не отправляется, в логе
  `daily cap … reached`;
- в логе — только исход и маска адресата (`code delivery: telegram signup for +79•••••••22: sent`), без кода и
  без токена (токен — в адресе запроса Bot API, поэтому текст ошибки `fetch` не логируется вовсе).

## Настройка (production)

1. **Бот.** В Telegram откройте @BotFather → `/newbot` → имя и username (например `denigram_codes_bot`).
   BotFather пришлёт токен вида `123456789:AA…` — это секрет: только в файле `secrets/run/telegram_bot_token` на
   сервере (docker secret, [deploy.md](deploy.md) «Секреты»), не в `.env`, не в репозиторий и не в чат.
2. **/start.** Из своего аккаунта Telegram откройте бота и отправьте `/start` — без этого бот не может вам писать.
3. **id чата.** Локально, где есть `bun` (токен — из переменной окружения, не аргументом; `read -s` — без эха и
   без истории shell):

   ```bash
   read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN && bun tools/telegram/chatId.ts; unset TELEGRAM_BOT_TOKEN
   ```

   Скрипт напечатает `TELEGRAM_OWNER_CHAT_ID=…`. Без `bun` — то же руками: откройте
   `https://api.telegram.org/bot<токен>/getUpdates` и возьмите `result[].message.chat.id` своего сообщения
   (у бота не должно быть webhook; ссылка содержит токен — не пересылайте её).
4. **Токен — в файл секрета, id чата — в `.env`** (сервер — [deploy.md](deploy.md)):

   ```bash
   sudo -u deploy /opt/relay/deploy/set-secret.sh telegram_bot_token   # спросит токен, ввод скрыт
   ```

   ```
   # /opt/relay/.env
   TELEGRAM_OWNER_CHAT_ID=123456789
   # необязательно:
   # TELEGRAM_DAILY_CAP=300
   # CODE_TIME_ZONE=Europe/Moscow     # в каком поясе писать «Действует до …», по умолчанию UTC
   ```

   `docker-compose.secure.yml` монтирует токен `server` и `worker` (`TELEGRAM_BOT_TOKEN_FILE`,
   `CODE_DELIVERY=telegram` по умолчанию) и без id чата не запустится; `server` в production проверяет то же сам (`assertTransportSecure`, `tls.ts`) и не стартует
   с `CODE_DELIVERY=telegram` без токена или числового id, с `CODE_DELIVERY=dev|log`, с `DEV_LOGIN=1` или
   `LOG_LOGIN_CODES=1`.
5. `docker compose -f docker-compose.yml -f docker-compose.secure.yml up -d server worker` и проверка: запросить
   код для нового номера — в чате с ботом придёт сообщение

   ```
   Relay — регистрация нового номера
   Номер: +79990001122
   Код: 12345
   Действует до 14:05 (UTC)
   ```

   Код моноширинный — в Telegram копируется нажатием. Передавайте его только тому, чей это номер.

Сменить токен: @BotFather → `/revoke`, новый — в `secrets/run/telegram_bot_token`, затем
`deploy/compose.sh restart server worker`.

## Проверка без Telegram

Bot API подменяется адресом `TELEGRAM_API_URL` (в production — только `https://`). Тесты —
`apps/server/test/codeDelivery.test.ts`: свой `Bun.serve` отвечает как `api.telegram.org`. Руками в dev:
любой сервер, который отвечает `{"ok":true}` на `POST /bot<токен>/sendMessage` и печатает тело запроса, и

```bash
CODE_DELIVERY=telegram TELEGRAM_BOT_TOKEN=1:test TELEGRAM_OWNER_CHAT_ID=1 \
  TELEGRAM_API_URL=http://host.docker.internal:8099 docker compose up -d server worker
```

## «Войти через Telegram»

Необязательный способ входа тем же ботом (`domain/telegramLogin.ts`, карточка `apps/web/src/ui/auth/TelegramCard.tsx`).
Не виджет Telegram Login — он не отдаёт номер, а аккаунт Relay — по номеру.

1. На экране входа «Войти через Telegram ›» → карточка с кнопкой «Открыть Telegram» и предупреждением, что Telegram
   узнает о Relay. Сервер выдаёт одноразовый токен (5 минут, в базе — хэш; привязан к ключу устройства браузера,
   как QR) и ссылку `https://t.me/<бот>?start=<токен>`.
2. Бот на `/start <токен>` закрепляет попытку за этим аккаунтом Telegram (ссылка, пересланная другому, ему уже
   не достанется) и просит контакт кнопкой «Поделиться номером».
3. Контакт принимается, только если он свой (`contact.user_id == from.id`); номер — только из контакта, в E.164.
   Сохраняется связка «аккаунт Telegram → номер» (`telegram_links`).
4. Браузер опрашивает `/auth/telegram/poll` раз в 2 с и дальше идёт как после верного кода: аккаунт есть — вход
   (неподтверждённый сеанс, облачный пароль спросят), номера нет — регистрация.
5. Повторный вход: связка уже есть — бот спрашивает «Войти в Relay как +7…?» кнопками «Войти», «Отмена», «Другой
   номер». `/stop` в боте снимает связку.

Регистрация через Telegram: номер ещё не зарегистрирован — бот при подтверждении запоминает имя и фамилию из
профиля Telegram (`from`) и `file_id` первого фото профиля (`getUserProfilePhotos`, размер до 800; скрытое фото,
ошибка или ответ дольше 3 с — без фото). Опрос отдаёт `prefill: { firstName, lastName, photo }`, форма регистрации
открывается заполненной («Имя и фото — из Telegram. Их можно поменять.»), фото убирается крестиком. Само фото
браузер берёт `POST /auth/signup/photo { pendingId }`: сервер скачивает файл у Telegram (в адресе файла — токен бота,
наружу уходят только байты, тип — по сигнатуре) и отдаёт его только по живой заявке регистрации. В профиль идёт то,
что человек подтвердил в форме; фото после регистрации ставится обычной загрузкой (квадрат по центру → 640/160).
Подсказка не хранится дольше входа: из `telegram_logins` она уходит при опросе, из заявки — при регистрации. Для
существующего аккаунта подсказки нет и фото у Telegram не спрашивается.

Коды входа самому человеку (бывший «этап 2»): при `CODE_DELIVERY=telegram` код для номера со связкой уходит в его
чат с ботом, а не владельцу; бот заблокирован — связка снимается, код уходит владельцу.

Лимиты: 20 ссылок в час с адреса, 10 попыток в час на аккаунт Telegram; общий дневной потолок сообщений —
`TELEGRAM_DAILY_CAP`. В лог не пишутся ни номера, ни токены.

### Настройка

Тот же бот, что для кодов. @BotFather `/setdomain` **не нужен** (это для виджета). В `.env`:

```
TELEGRAM_LOGIN=1
TELEGRAM_BOT_USERNAME=denigram_codes_bot        # без @
# webhook (production): адрес сервера; секрет заголовка X-Telegram-Bot-Api-Secret-Token — файлом
# secrets/run/telegram_webhook_secret (его создаёт deploy/make-secrets.sh; в dev — TELEGRAM_WEBHOOK_SECRET)
TELEGRAM_WEBHOOK_URL=https://denigram.site/auth/telegram/webhook
```

Воркер при старте сам вызывает `setWebhook` (адрес, секрет, только `message` и `callback_query`). Без
`TELEGRAM_WEBHOOK_URL` воркер опрашивает `getUpdates` (dev, сервер без входящего HTTPS; опрашивает один воркер —
advisory-замок). Пока стоит webhook, `tools/telegram/chatId.ts` не работает (Telegram отвечает 409): узнайте id чата
до включения webhook или временно снимите его (`deleteWebhook`). Production не стартует с `TELEGRAM_LOGIN=1` без
токена и имени бота, с webhook не по https или без секрета (`tls.ts`).

Проверка без Telegram: `TELEGRAM_API_URL` на свой mock и обновления бота — POST на `/auth/telegram/webhook` с
заголовком секрета (так делает `apps/server/test/telegramLogin.test.ts`).
