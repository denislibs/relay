# Наблюдаемость

Что есть, чтобы судить о выкате (и потом о канарейке) по числам: готовность процессов, метрики Prometheus с меткой
сборки, структурные логи, отчёты об ошибках клиентов, панель Grafana и тревоги в Telegram владельцу.

## Коротко

| Что | Где | Кто видит |
|---|---|---|
| `/health` — процесс жив | server :3000 (через nginx), внутренний порт :9091, keys :7800 | все |
| `/ready` — Postgres, Valkey, KMS отвечают | server :3000 и :9091, worker :9091, keys :7800 (только Vault) | все; ответ — только `ok` и булевы флаги |
| `/metrics` — Prometheus | server и worker, `METRICS_PORT` (по умолчанию 9091) | только внутренняя сеть compose; nginx его не проксирует, порт не публикуется |
| `POST /client-errors`, `POST /client-stats` | server :3000 (через nginx) | клиенты; лимит 20 отчётов в минуту на IP, тело ≤ 16 КБ |
| Grafana | `127.0.0.1:3001` на сервере | владелец, через `ssh -L` |
| Тревоги | свой бот Telegram (не тот, что коды входа) → `TELEGRAM_OWNER_CHAT_ID` | владелец |

Сборка: `BUILD_ID` из окружения или файл `/app/BUILD_ID`, который пишет `apps/server/Dockerfile`
(`--build-arg BUILD_ID=<git sha>`; без аргумента — время сборки). Тот же id получает клиент (`__BUILD__`), поэтому
ошибки клиентов и метрики сервера сравниваются по одной сборке.

## Запуск

Профиль `observability` — отдельный слой compose поверх стека (`deploy/docker-compose.observability.yml`):

На боевом сервере — `RELAY_OBSERVABILITY=1` в `.env`: `deploy/compose.sh` и `deploy.sh` сами добавляют слой и
профиль ([deploy.md](deploy.md)):

```bash
sudo -u deploy sed -i 's/^RELAY_OBSERVABILITY=.*/RELAY_OBSERVABILITY=1/' /opt/relay/.env && /opt/relay/deploy/compose.sh up -d
```

Секреты — файлами, как у всего боевого стека: токен бота тревог — `secrets/run/alert_bot_token`, пароль Grafana —
`secrets/run/grafana_admin_password` (оба создаёт `deploy/make-secrets.sh`, первый — пустым); в `.env` — только
`TELEGRAM_OWNER_CHAT_ID`. Бот тревог — **отдельный** от бота кодов входа: тот может упереться в дневной предел или быть
заблокирован, а тревога об этом должна дойти. Завести: @BotFather → `/newbot`, затем написать новому боту `/start`
(иначе он не сможет писать владельцу) и `sudo -u deploy /opt/relay/deploy/set-secret.sh alert_bot_token`; пустой
токен при `RELAY_OBSERVABILITY=1` — `deploy.sh` не выкатывает, alertmanager не стартует. Локально поверх
`docker-compose.yml` — те же два файла в `./secrets/run/` (тогда тревоги уйдут в настоящий Telegram, если токен
настоящий):

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.observability.yml --profile observability up -d
```

Что поднимается (пределы памяти; в работе вместе ≈ 200 МБ, пределы — 600 МБ):

| Сервис | Зачем | Память |
|---|---|---|
| victoriametrics | хранит ряды 30 дней, опрашивает цели раз в 15–60 с | 220 МБ |
| vmalert | считает правила тревог раз в 30 с | 40 МБ |
| alertmanager | группирует тревоги, шлёт в Telegram | 40 МБ |
| node-exporter | диски (`/`, `/srv/relay-s3`), память, CPU хоста | 30 МБ |
| cadvisor | память и CPU по контейнерам (метка `service`) | 110 МБ |
| grafana | панель «Relay» | 160 МБ |

Цели опроса (`deploy/observability/victoriametrics/scrape.yml`): `server` и `worker` (все реплики сервиса по DNS
Docker, порт 9091), coturn (`turn:9641`, опция `prometheus` в `docker/coturn/turnserver.conf`), LiveKit
(`livekit:6789`, `prometheus_port` в `docker/livekit/livekit.yaml`), node-exporter, cadvisor и сами сервисы профиля.
Проверить: `deploy/compose.sh exec server bun -e "console.log(await (await fetch('http://victoriametrics:8428/api/v1/targets')).text())"`
или вкладка Explore в Grafana (`up`).

## Grafana через SSH

Grafana слушает только `127.0.0.1:3001` сервера. С ноутбука:

```bash
ssh -N -L 3001:127.0.0.1:3001 root@denigram.site
```

Затем <http://localhost:3001>, вход `admin` / пароль из `secrets/run/grafana_admin_password`. Панель «Relay» — домашняя. Переменная
«Сборка» оставляет на всех графиках только выбранные сборки; фиолетовые отметки «Выкаты» — когда у server
появилась новая сборка.

Разделы панели: обзор (запросы, доля 5xx, p95, сокеты, очередь, зависимости), API по сборкам, WebSocket (сокеты,
кадры по op, ошибки кадров по коду, в т. ч. `flood`), задачи, звонки (исходы 1:1, причины завершения, доля через
TURN, входы в групповые, ошибки LiveKit, нагрузка LiveKit/TURN), коды входа и ошибки клиентов, диски и память.

Панель — файл `deploy/observability/grafana/dashboards/relay.json` (правки в интерфейсе не сохраняются: поменяйте
файл и перезапустите grafana).

## Метрики

У каждой серии Relay — метка `build`; `job` и `instance` добавляет VictoriaMetrics. Метки — только из ограниченных
наборов (группа маршрута, op кадра, код ошибки, kind задачи); id пользователей, чатов и пути целиком в метки не
попадают.

| Метрика | Метки | Процесс |
|---|---|---|
| `relay_http_requests_total` | `route` (первый сегмент пути), `method`, `status` | server |
| `relay_http_request_duration_seconds` | `route` | server |
| `relay_ws_connections` | — | server |
| `relay_ws_frames_total` | `op`, `result` (`ok` или код ошибки; `flood` — сверх 100 кадров/с) | server |
| `relay_ws_closes_total` | `reason` (`flood`, `proof_failed`, `proof_queue`) | server |
| `relay_jobs_processed_total` | `kind`, `result` (`ok`, `retry`, `dead`) | worker (и server — задачи в тестах) |
| `relay_job_duration_seconds` | `kind` | worker |
| `relay_jobs_ready`, `relay_jobs_lag_seconds`, `relay_jobs_dead` | `kind` | worker |
| `relay_call_requests_total` | `result` (`ok`, `busy`, `in_call`, `unavailable`, `flood`, код ошибки) | server |
| `relay_call_ends_total` | `reason` (`ended`, `missed`, `declined`, `cancelled`, `busy`, `failed`, `unavailable`) | server, worker |
| `relay_call_paths_total` | `kind` (`p2p`), `path` (`direct`, `relay`), `client_build` | server (из `/client-stats`) |
| `relay_group_call_joins_total` | `via` (`direct`, `link`), `result` | server |
| `relay_livekit_errors_total` | `method`, `reason` (HTTP-статус, `timeout`, `network`) | server |
| `relay_code_deliveries_total` | `channel` (`telegram`), `result` (`ok`, `failed`, `capped`, `expired`) | worker |
| `relay_client_errors_total` | `source`, `client_build` | server |
| `relay_client_reports_dropped_total` | `reason` (`rate`, `size`, `bad`) | server |
| `relay_dependency_up` | `dep` (`postgres`, `valkey`, `kms`) | server, worker |
| `relay_build_info`, `relay_process_memory_bytes`, `relay_process_uptime_seconds` | `proc`; `kind` | все |

Канарейка: сравнивать `sum by (build)` доли 5xx, p95 и `relay_client_errors_total` по `client_build` между старой и
новой сборкой.

## Логи

Горячие пути пишут одну строку JSON: `{"ts","level","msg","build","proc", ...}`. Поля: `reqId` (из `x-request-id`
nginx или свой; тот же id — в заголовке ответа), `userId` — когда известен, `route`, `path` (длинные токены
заменены на `:tok`), `jobId`/`kind`, `err` и начало стека.

- `http handler failed` (error) — неожиданное исключение, клиент получил `internal`;
- `http 5xx`, `http slow` (warn) — ответ 5xx или дольше 2 с;
- `ws frame failed` (error) — исключение в кадре WebSocket;
- `job failed, will retry` (warn), `job failed permanently` (error), `job batch failed, running one by one`;
- `livekit api failed` (warn);
- `client error` (warn) — отчёт клиента: `source`, `clientBuild`, сообщение и стек без строк запроса и токенов
  (не больше 300 строк в минуту на процесс).

Секретов в логах нет: поля с именами вроде `code`, `token`, `secret`, `password`, `phone`, `cookie`, `sig`
выбрасываются (`apps/server/src/obs/log.ts`); payload задач не пишется; коды входа в лог не передаются вовсе.
Найти всё про запрос: `deploy/compose.sh logs server | grep '"reqId":"<id из ответа>"'`.

## Ошибки клиентов

`packages/sync-engine/src/errorReport.ts`: пачка раз в 5 с, одинаковые ошибки склеиваются со счётчиком, за жизнь
страницы — не больше 50 записей, при уходе со страницы — `keepalive`. Источники:

- `window`, `promise` — `window.onerror` и `unhandledrejection` страницы (`apps/web/src/errorReport.ts`);
- `worker`, `host` — SharedWorker / Dedicated Worker движка: необработанные ошибки и сбои хоста;
- `call` — звонок 1:1 не соединился или оборвался (`p2p failed: connection=… ice=… connected=… relay=…`),
  подмена DTLS (`p2p security`);
- `groupCall` — LiveKit не подключился.

`/client-stats` — путь соединившегося звонка 1:1: выбранная пара кандидатов, хоть один конец `relay` → через TURN.

## Тревоги

Правила — `deploy/observability/vmalert/alerts.yml`, доставка — `deploy/observability/alertmanager/alertmanager.yml`.
Одна тревога одного вида — одно сообщение (группировка по имени), повтор раз в 4 часа, «прошло» — когда погасла.

| Тревога | Когда | Что значит | Что делать |
|---|---|---|---|
| `RelayHttp5xx` (critical) | 5xx > 2 % ответов сборки и > 3 в минуту, 5 мин | сервер падает на запросах | `deploy/compose.sh logs --since 15m server \| grep '"level":"error"'`; началось сразу после выката — откатить |
| `RelayS3DiskFull` (warning) | `/srv/relay-s3` занят > 80 %, 10 мин | раздел вложений кончается | увеличить раздел; проверить, что `storage.gc` работает (логи воркера); на 100 % загрузки файлов падают |
| `RelayDiskFull` (warning) | `/` занят > 80 %, 10 мин | системный диск кончается | `docker system df`, `docker image prune -a`, логи контейнеров, WAL Postgres |
| `RelayKmsNotReady` (critical) | `relay_dependency_up{dep="kms"}` = 0, 2 мин | OpenBao запечатан (перезапуск хоста/контейнера) или сервис ключей лежит: новые чаты и файлы не шифруются, старые не открываются | `deploy/bao-unseal.sh`; затем `curl https://denigram.site/ready` → `"kms":true` |
| `RelayDependencyDown` (critical) | нет Postgres или Valkey, 2 мин | база или Valkey недоступны | `deploy/compose.sh ps`; логи сервиса; место на диске и память |
| `RelayTargetDown` (critical) | server/worker не отвечает на /metrics, 2 мин | процесс упал или перезапускается в цикле | `deploy/compose.sh ps`, `logs server`; после выката — откатить |
| `RelayJobsDead` (warning) | задача ушла в `jobs_dead` за 15 мин | работа не доделана (превью, рассылка, удаление) | `select kind, last_error, failed_at from jobs_dead order by failed_at desc limit 20;` |
| `RelayJobsRetrying` (warning) | повторы задач kind > 0,2/с, 10 мин | обработчик падает | логи воркера `grep 'job failed'`; обычно недоступен S3, Meilisearch или Telegram |
| `RelayJobsStuck` (warning) | старейшая готовая задача ждёт > 10 мин | воркер не успевает или стоит | `deploy/compose.sh ps worker`; забит ли пул видео/фото |
| `RelayTelegramDeliveryFailed` (critical) | код входа не ушёл (`failed`) или упёрся в дневной предел (`capped`) | люди не могут войти | логи воркера `grep 'code delivery'`; `capped` — поднять `TELEGRAM_DAILY_CAP`; `failed` — токен, бот заблокирован, сеть |
| `RelayDeployRolledBack` (critical) | шлёт `deploy.sh`, когда наблюдение после выката откатило сборку | новая сборка хуже прежней: причина — в тексте | лог шага deploy в Actions; починить и выкатить заново ([deploy.md](deploy.md), «Наблюдение после выката») |
| `RelayZombieProcesses` (warning) | зомби-процессов на хосте > 100, 10 мин | процесс №1 какого-то контейнера не хоронит детей; через часы — лимит процессов, контейнер перестаёт запускать что-либо | найти родителя (`ps -eo ppid,stat`), контейнеру `init: true` в compose, перезапустить |
| `RelayContainerUnhealthy` (critical) | контейнер нездоров или не запущен, 3 мин (`deploy/host-metrics.sh`) | зависящие сервисы не поднимутся при выкате (S3, 2026-11-07) | `deploy/compose.sh ps`, логи контейнера |
| `RelayContainerRestarting` (warning) | > 2 перезапусков за 15 мин | падает по кругу | логи контейнера |
| `RelayCertExpiring` (warning) | сертификат истекает через < 21 дня | certbot не продлил или внутренним год | certbot renew / `deploy/certs.sh` |
| `RelayBackupStale` (warning) | файлам бэкапа > 26 ч | ночной бэкап не прошёл | `/home/deploy/relay-cron.log`, `deploy/backup.sh` руками |
| `RelayBaoTokenExpiring` (critical) | токену OpenBao < 7 дней (`deploy/bao-renew.sh` пишет срок; 0 — продлить не удалось) | истечёт — ключи чатов не разворачиваются | `deploy/bao-renew.sh`, OpenBao распечатан? |
| `RelayHostMetricsStale` (warning) | `host-metrics.sh` не отрабатывал > 10 мин | тревоги выше слепы | cron пользователя deploy |
| `RelayProcessMemoryHigh` (warning) | RSS server/worker > 1,5 ГБ, 30 мин | утечка памяти | heap snapshot, перезапуск |
| `RelayHostMemoryLow` (warning) | свободно < 10 % памяти, 10 мин | скоро OOM | панель «Память контейнеров»; первыми растут worker (ffmpeg) и postgres |

Проверить доставку тревог без поломки: `deploy/compose.sh exec alertmanager amtool alert add test severity=warning --annotation=summary=проверка --alertmanager.url=http://127.0.0.1:9093`.

## Безопасность

- `/metrics` нет на публичном порту: внутренний сервер `apps/server/src/obs/server.ts`, порт не публикуется,
  nginx отдаёт `/metrics` в `server:3000`, а там его нет (404).
- `/ready` публичен, но отвечает только булевыми флагами и кэшируется на 2 с — частый опрос не нагружает базу.
- `/ready` сервиса ключей — без токена и только `{"ok": true|false}`; остальные ручки — как раньше, с токеном.
- `/client-errors` принимается без входа (ошибки экрана входа), поэтому: лимит на IP, тело ≤ 16 КБ (поток без
  `Content-Length` обрывается на пределе), ≤ 10 записей, метки только из списков, сборок клиента в метке — не
  больше 8 на процесс.
- Grafana — только `127.0.0.1`, вход по паролю, регистрация и анонимный доступ выключены. Токен бота тревог в
  alertmanager — docker secret (файл), не в конфиге и не в логах.
