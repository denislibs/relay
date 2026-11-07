# Развёртывание Relay на denigram.site

Один сервер (OVH, Ubuntu 26.04, 4 vCPU / 7,6 ГБ / 72 ГБ, `158.69.233.92`), выкат — GitHub Actions. Этот документ —
как всё устроено, первая настройка сервера, ежедневный выкат, откат, распечатка OpenBao после перезагрузки, бэкапы
и восстановление. Коды входа — [code-delivery.md](code-delivery.md), устройство приложения — [../ARCHITECTURE.md](../ARCHITECTURE.md).

## Как устроено

```
push в master ──► deploy.yml: ci.yml (секреты в git, типы, 6 наборов тестов, сборка клиента и образов, миграции)
                     │
                     ▼
                  сборка и push: ghcr.io/denislibs/relay-server:<sha>, relay-proxy:<sha> (+ latest)
                     │  ssh deploy@denigram.site "deploy <sha>" (ключ CI может только deploy | rollback | status —
                     ▼  deploy/ci-entry.sh)
                  /opt/relay/deploy/deploy.sh <sha>
                     checkout <sha> → pull → migrate → up -d → healthy → секретов нет в docker inspect →
                     https://denigram.site/version.json = <sha>, /health = ok → deploy/state/current = <sha>;
                     ошибка — откат на прежний тег тем же путём
                     │
                     ▼
                  браузер (Playwright, Chromium): оболочка приложения, Service Worker, консоль без ошибок,
                  /health, /ready, сборка = <sha>; не прошло — "rollback" на прежнюю версию
```

На сервере:

| Где | Что |
|---|---|
| `/opt/relay` | git checkout репозитория (публичный): compose-файлы и конфиги — того же коммита, что образы. Владелец — `deploy` |
| `/opt/relay/secrets/run` | **секреты**, файл на значение (`deploy/make-secrets.sh`, `bao-init.sh`): владелец deploy, группа 1000, 640. Не в git |
| `/opt/relay/.env` | несекретные настройки: домен, адреса, флаги (`deploy/make-secrets.sh`; пример — `.env.example`). Не в git |
| `/opt/relay/secrets/tls` | внутренний CA и сертификаты сервисов (`deploy/certs.sh`). Не в git |
| `/opt/relay/secrets/public` | сертификат домена (копирует хук certbot). Не в git |
| `/opt/relay/deploy/state` | `current`, `previous`, `history` — что развёрнуто. Не в git |
| `/srv/relay-s3` | данные SeaweedFS (отдельный раздел ext4, 20 ГБ) |
| `/srv/relay-acme` | webroot проверки Let's Encrypt (certbot пишет, nginx отдаёт на :80) |
| `/srv/relay-assets` | стикеры и эмодзи (ASSETS_DIR, вне git и образа; пустой — без них) |
| `/srv/relay-backups` | бэкапы (`deploy/backup.sh`), всё зашифровано age |
| `/root/relay-openbao-init.json` | вывод `bao operator init` — только до того, как ключи разнесены по местам, потом удалить |

Слои compose: `docker-compose.yml` (dev) → `docker-compose.secure.yml` (боевая защита: TLS внутри, mTLS к Postgres,
read-only, не root, сервис ключей, секреты файлами) → `deploy/docker-compose.prod.yml` (этот сервер). Вызывать — только через
`deploy/compose.sh`: он подставляет все три файла, проект `relay` и развёрнутый тег.

`deploy/docker-compose.prod.yml` поверх secure:

- **образы из GHCR** вместо сборки на хосте: `relay-server` — server, worker, keys, migrate; `relay-proxy` — nginx
  со сборкой клиента внутри (сервис `web` и том `webdist` больше не нужны). Тег — полный git sha, `RELAY_TAG`.
  Конфиги сайта nginx монтируются из checkout того же коммита;
- **OpenBao** (`openbao/openbao:2.7.2`, боевой режим, встроенное хранилище raft на одном узле в томе
  `openbao-data` — `file` в OpenBao 2.x убран; TLS сертификатом внутреннего CA `bao.pem`; стартует от root только
  чтобы скопировать ключ TLS, сервер работает от `openbao`). Сеть `bao` — internal, в ней только `openbao` и `keys`
  (`VAULT_ADDR=https://openbao:8200`); у server и worker доступа к нему нет. mlock OpenBao больше не поддерживает —
  поэтому swap на сервере выключен или зашифрован (ниже);
- данные SeaweedFS — `/srv/relay-s3`, а не том;
- TURN: релей `49152–49952/udp`, полоса `max-bps=2500000` байт/с на сессию; LiveKit — `50000–50060/udp`, `7881/tcp`;
  внешний адрес у обоих — из `.env`;
- healthcheck: server — `GET /ready` (Postgres, Valkey, KMS), worker — `/ready` на внутреннем порту 9091, keys —
  `/ready` (OpenBao распечатан; без токена и мимо журнала аудита), proxy — `/version.json`, OpenBao — «распечатан»;
  `restart: unless-stopped` у всех долгоживущих;
- наблюдаемость ([observability.md](observability.md): VictoriaMetrics, тревоги в Telegram, Grafana) — по желанию:
  `RELAY_OBSERVABILITY=1` в `.env`, и `deploy/compose.sh` / `deploy.sh` подключают `deploy/docker-compose.observability.yml`
  с профилем `observability`.

Порты наружу (ufw + DOCKER-USER уже пускают ровно их): `80`, `443`, `8333` (S3 по подписанным ссылкам) — proxy;
`3478 tcp/udp`, `49152–49952/udp` — TURN; `7881/tcp`, `50000–50060/udp` — LiveKit. Postgres, Valkey, S3, поиск,
сервис ключей и OpenBao портов не публикуют.

## Секреты: где живут и откуда берутся

В репозитории секретов нет и быть не может: `.gitignore` закрывает `.env*` (кроме `.env.example` без значений),
`secrets/`, `*.pem`, `*.key`, `*.age`, `backups/`, вывод `bao operator init`; CI на каждом PR и push ищет секреты
gitleaks (`.gitleaks.toml`: исключены только dev-значения `docker-compose.yml` и тестовые фикстуры) — находка валит
сборку. Попал настоящий секрет в git — не «исключать», а **отозвать и выпустить новый** (история публичная).

На сервере секреты — **файлы** `secrets/run/<имя>` (docker secrets): каждому контейнеру монтируется только нужное
(`/run/secrets/<имя>`), процессы читают `X_FILE` (`apps/server/src/secretFiles.ts`), сторонние — через файл или
обёртку при старте. Ни в `environment`, ни в аргументах команд, ни в образах: `deploy.sh` при каждом выкате
сверяет `docker inspect` всех контейнеров со всеми файлами секретов (значения не печатаются) — совпадение валит
выкат; тест `tools/ci/compose-secrets.test.ts` проверяет то же на уровне compose-файлов. Скрипты значений не
печатают — только имена («generated», «kept»).

| Секрет (файл в `secrets/run/`) | Кто создаёт | Кому монтируется |
|---|---|---|
| `pg_password` | make-secrets (случайный) | postgres (`POSTGRES_PASSWORD_FILE`), migrate, server, worker |
| `valkey_password` | make-secrets | valkey (конфиг при старте), server, worker |
| `s3_access_key_id`, `s3_secret_access_key` | make-secrets | s3 (`s3-secure.sh`), server, worker |
| `meili_master_key` | make-secrets | search (обёртка), worker |
| `meili_search_key` | make-secrets: HMAC-SHA256(мастер, uid) — так выводит сам Meilisearch | server |
| `key_token_server`, `key_token_worker`, `key_service_tokens` | make-secrets | server, worker; список обоих — keys |
| `key_service_audit_key` | make-secrets | keys |
| `vault_token` | bao-init (периодический токен OpenBao, политика `relay-keys`) | keys |
| `bao_backup_token` | bao-init (только снимок raft) | никому: читает `backup.sh` на хосте |
| `turn_secret` | make-secrets | turn (в копию конфига при старте), server |
| `livekit_api_key`, `livekit_api_secret`, `livekit_keys` | make-secrets | server; «ключ: секрет» — livekit (`--key-file`) |
| `telegram_bot_token` | **владелец** (BotFather) | server, worker |
| `telegram_webhook_secret` | make-secrets | server, worker |
| `grafana_admin_password` | make-secrets | grafana (`GF_SECURITY_ADMIN_PASSWORD__FILE`; только с наблюдаемостью) |

Токен бота монтируется и alertmanager (`bot_token_file`), если включена наблюдаемость. Процессы alertmanager и
Grafana не root — им добавлена группа 1000.

Вне `secrets/run`:

| Секрет | Где живёт |
|---|---|
| ключи распечатки OpenBao (3, порог 2) | только у владельца, в трёх разных местах; на сервере — нигде (init-файл удаляется) |
| главный ключ чатов (transit `relay-chat-keys`) | только внутри OpenBao (не экспортируемый) |
| внутренний CA и ключи сервисов | `secrets/tls` (`deploy/certs.sh`) |
| сертификат и ключ домена | `/etc/letsencrypt` (certbot) → копия в `secrets/public` (хук) |
| закрытые ключи age бэкапов | только у владельца, не на сервере; на сервере — открытые (`AGE_DATA`, `AGE_KEYS` в `.env`) |
| учётка rclone | `~deploy/.config/rclone/rclone.conf` (600) |
| `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS` | GitHub → Environment `production` → secrets (маскируются в логах) |
| запись в GHCR | `GITHUB_TOKEN` запуска (выдаёт GitHub, живёт минуты) |
| чтение GHCR на сервере (если пакеты приватные) | `~deploy/.docker/config.json` (PAT `read:packages`) |

## Первая настройка сервера## Первая настройка сервера

Всё ниже — один раз. Команды от root, если не сказано иное.

### 1. Пакеты, Docker, swap

```bash
apt update && apt install -y git jq curl openssl age certbot rclone
# Docker Engine и compose plugin — по https://docs.docker.com/engine/install/ubuntu/
```

`/etc/docker/daemon.json`:

```json
{
  "userland-proxy": false,
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true
}
```

`userland-proxy: false` обязателен: у TURN 800 UDP-портов, с userland-proxy это 800 процессов docker-proxy.
Ротация логов — иначе журналы контейнеров съедят диск. `systemctl restart docker`.

Swap: OpenBao не умеет mlock — расшифрованный ключ не должен уходить в swap. `swapon --show` пусто — хорошо;
есть swap — выключить (`swapoff -a`, убрать из `/etc/fstab`) или сделать его шифрованным.

### 2. Пользователь deploy и каталоги

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy           # docker = root на этой машине: ключ deploy берегите
install -d -o deploy -g deploy /opt/relay /srv/relay-backups
install -d -m 755 /srv/relay-acme /srv/relay-assets
# /srv/relay-s3 — уже смонтированный раздел ext4; данные пишет root из контейнера
sudo -u deploy git clone https://github.com/denislibs/relay /opt/relay
```

SSH-ключ CI (на своей машине, не на сервере):

```bash
ssh-keygen -t ed25519 -N "" -C github-actions-deploy -f relay-deploy-ci
```

В `/home/deploy/.ssh/authorized_keys` (права 600, владелец deploy) — **открытый** ключ с принудительной командой
(`deploy/ci-entry.sh`): ключ CI может только `deploy <sha>`, `rollback [<sha>]` и `status` (sha — 7–40 hex,
строго), без shell, пробросов и pty:

```
restrict,command="/opt/relay/deploy/ci-entry.sh" ssh-ed25519 AAAA… github-actions-deploy
```

Свой ключ для работы руками — отдельной строкой, без `command=`.

### 3. Доступ к GHCR

Пакеты `relay-server` и `relay-proxy` появляются в GHCR после первого выката из Actions. По умолчанию они приватные:

- либо сделать их публичными (GitHub → профиль → Packages → пакет → Package settings → Change visibility → Public;
  в образах нет секретов: `.dockerignore` исключает `.env*`, `secrets/`, ключи, бэкапы и `.git`, а в образе proxy
  кроме nginx — только собранный `dist`);
- либо войти на сервере (от deploy) токеном только на чтение пакетов (classic PAT, scope `read:packages`):

```bash
sudo -u deploy docker login ghcr.io -u <github-user> --password-stdin   # вставить токен, Enter, Ctrl-D
```

### 4. Секреты и настройки

```bash
cd /opt/relay
sudo env RELAY_DOMAIN=denigram.site RELAY_PUBLIC_IP=158.69.233.92 deploy/make-secrets.sh
```

Скрипт создаёт файлы секретов в `secrets/run/` (таблица выше: пароли Postgres и Valkey, учётка S3, ключи
Meilisearch, токены и ключ аудита сервиса ключей, секрет TURN, ключи LiveKit, секрет webhook Telegram) и `.env` с
несекретными настройками — и печатает только имена. Повторный запуск добавляет только недостающее, существующие
значения не меняет.

`meili_search_key` выводится из мастер-ключа так же, как это делает сам Meilisearch: HMAC-SHA256(мастер-ключ, uid
ключа), hex. uid — тот же, что в `apps/server/src/dev/meiliKeys.ts` (тест `tools/ci/deploy.test.ts` следит).
`deploy.sh` при каждом выкате создаёт ключ с этим uid (идемпотентно) и сверяет — расхождение валит выкат.

Вписать руками:

- токен бота — в файл, не в командную строку и не в `.env`:
  `sudo -u deploy sh -c 'cat > /opt/relay/secrets/run/telegram_bot_token'` (вставить, Enter, Ctrl-D);
- в `.env` (`sudo -u deploy nano /opt/relay/.env`): `TELEGRAM_OWNER_CHAT_ID` — обязательно
  ([code-delivery.md](code-delivery.md)); для «Войти через Telegram» — `TELEGRAM_LOGIN=1` и `TELEGRAM_BOT_USERNAME`
  (адрес webhook `https://denigram.site/auth/telegram/webhook` и секрет к нему make-secrets уже завёл; worker сам
  вызывает setWebhook при старте); `AGE_DATA`, `AGE_KEYS` — для бэкапов, `BACKUP_RCLONE_DATA`,
  `BACKUP_RCLONE_KEYS` — для копий вне сервера.

`vault_token` и `bao_backup_token` пока пустые — их заполнит `bao-init.sh`.

### 5. Внутренние сертификаты

```bash
/opt/relay/deploy/certs.sh
```

CA (10 лет) и сертификаты postgres, valkey, s3, search, keys, bao, client (1 год). Скрипт ещё и раздаёт владельцев
ключей: процессы в контейнерах не root (bun — uid 1000, valkey — 999), а ключ с правами 600 читает только владелец.

### 6. Сертификат домена (Let's Encrypt)

Первый выпуск — когда proxy ещё нет: временный nginx отдаёт webroot на :80, certbot проверяет домен, дальше
продление идёт тем же webroot через proxy.

```bash
docker run -d --rm --name acme-bootstrap -p 80:80 -v /srv/relay-acme:/usr/share/nginx/html:ro nginx:1.30.6-alpine
certbot certonly --webroot -w /srv/relay-acme -d denigram.site -d www.denigram.site \
  --agree-tos -m <ваш email> --no-eff-email
docker stop acme-bootstrap

ln -s /opt/relay/deploy/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/relay.sh
RENEWED_LINEAGE=/etc/letsencrypt/live/denigram.site /opt/relay/deploy/certbot-deploy-hook.sh
certbot renew --dry-run
```

Хук копирует `fullchain.pem`/`privkey.pem` в `secrets/public/server.pem`/`server-key.pem` и делает `nginx -s reload`.
Продление — systemd-таймер пакета certbot (`systemctl list-timers | grep certbot`). `www.` перенаправляется на
`denigram.site` (production.conf): подписанные ссылки S3, CSP и passkeys привязаны к одному имени.

### 7. OpenBao

```bash
/opt/relay/deploy/bao-init.sh
```

Скрипт: `bao operator init` (3 ключа распечатки, порог 2) — вывод **только** в `/root/relay-openbao-init.json`
(600); распечатка двумя ключами; движок transit и ключ `relay-chat-keys` (aes256-gcm96, не экспортируемый, удалять
нельзя); политика `relay-keys` — `encrypt`, `decrypt`, `rewrap` этим ключом и чтение его версии
(`transit/keys/relay-chat-keys`, нужно `crypto/kms.ts` для перезаворачивания), больше ничего; периодический токен
(768h) с этой политикой — в `secrets/run/vault_token`, не печатая; второй периодический токен — только снимок
raft для бэкапа (политика `relay-backup`, `secrets/run/bao_backup_token`); отзыв root-токена. Токены (и root, пока
он есть) уходят в контейнер первой строкой stdin — не аргументом и не `exec -e`. Повторный запуск продолжает с
прерванного шага, после завершения — ничего не делает.

Затем **сразу**:

1. разнести три ключа распечатки (`jq -r '.unseal_keys_b64[]' /root/relay-openbao-init.json`) по трём разным
   местам: менеджер паролей, бумага в сейфе, второй человек… Двух из трёх достаточно, чтобы распечатать; одного —
   нет;
2. `shred -u /root/relay-openbao-init.json`.

Root-токена после этого нет. Нужен будет для администрирования (новая политика, ротация ключа transit) —
`bao operator generate-root` с ключами распечатки.

Оба токена периодические: продлеваются при каждом выкате и cron'ом (`deploy/bao-renew.sh`, ниже). Не продлевать
больше 32 дней — истекут, сервис ключей перестанет разворачивать ключи чатов; новый токен — только через
generate-root. Поэтому cron; срок видно в `deploy/status.sh`.

### 8. GitHub

Settings → Environments → `production` (по желанию — Required reviewers: выкат будет ждать подтверждения).
Секреты окружения:

| Секрет | Значение |
|---|---|
| `DEPLOY_HOST` | `denigram.site` (или `158.69.233.92`) |
| `DEPLOY_SSH_KEY` | закрытый ключ `relay-deploy-ci` целиком |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 denigram.site` — **сверить** отпечаток с `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` на сервере |

GHCR пишет `GITHUB_TOKEN` (permissions `packages: write` в deploy.yml) — отдельного секрета не нужно.

#### Обязательные проверки для master

Settings → Branches (или Rules) → правило для `master`: Require a pull request, Require status checks to pass —
все задания `ci.yml` (имена — как в списке проверок PR):

- `secrets (gitleaks)`
- `typecheck`
- `unit (apps/web)`, `unit (packages/relay-ui)`, `unit (packages/protocol)`, `unit (tools/ci)`
- `migration lint`
- `web build (production)`
- `server tests`, `engine tests`
- `build images`

Один известный нестабильный тест сервера — `bus.test.ts` «a socket opened after Valkey lost the process key still
counts» (гонка вокруг перезапуска Valkey) — задание `server tests` повторяет один раз, если упал только он;
предупреждение видно в логе. Любой другой провал или повторный — красный CI.

Плюс Require branches to be up to date. Тогда в master попадает только то, что прошло всё, — а deploy.yml на коммите
master прогоняет ci.yml ещё раз перед выкатом.

### 9. Первый выкат и cron

Actions → deploy → Run workflow (ветка master, tag пустой) — CI, сборка, выкат. Или руками на сервере, когда образы
уже в GHCR: `sudo -u deploy /opt/relay/deploy/deploy.sh <sha>`.

`crontab -e` пользователя deploy:

```
# продлить токен сервиса ключей OpenBao
20 4 * * * /opt/relay/deploy/bao-renew.sh >> /home/deploy/relay-cron.log 2>&1
# бэкап (age), копии вне сервера — rclone
15 3 * * * /opt/relay/deploy/backup.sh >> /home/deploy/relay-cron.log 2>&1
```

## Ежедневно: выкат

Merge PR в master — и всё: `deploy.yml` прогоняет CI ещё раз на коммите master, собирает и публикует образы с тегом
sha (и `latest`), заходит на сервер (`deploy <sha>` → `deploy.sh <sha>`) и затем открывает сайт в настоящем
браузере (`tools/ci/browser-smoke.mjs`: оболочка приложения отрисовалась, Service Worker активен, в консоли нет
ошибок, `/health` и `/ready` в порядке, `/version.json` = sha). Браузер увидел поломку — `rollback` на прежнюю
версию. Выкаты не пересекаются (concurrency
`deploy-production`, плюс замок `deploy/state/lock` на сервере): следующий ждёт предыдущий.

Итог — в Summary запуска: ✅ выкачено; ❌ упало и откатилось на прежнюю версию (код 1); 🔥 упало, и откат тоже
(код 2 — руками). Хвост вывода `deploy.sh` — там же.

Что делает `deploy.sh <sha>`:

1. проверки: `.env` 600, файлы секретов на месте (токен бота и `vault_token` не пустые), сертификат домена, OpenBao
   распечатан (иначе — отказ до любых изменений);
2. `git checkout --detach <sha>` в `/opt/relay` (руками правленые отслеживаемые файлы — отказ: лучше остановиться,
   чем выкатить не то);
3. `pull` образов, `run --rm migrate`, `up -d --remove-orphans`;
4. ждать healthy у keys, server, worker, proxy (до 240 с);
5. ни одного значения из `secrets/run` в `docker inspect` контейнеров (иначе — провал: секрет утёк в окружение);
6. ключ Meilisearch «только поиск» — создать/сверить; продлить токен OpenBao;
7. `https://denigram.site/version.json` отдаёт `<sha>` (сборка клиента в образе proxy — та самая), `/health` и
   `/ready` — ok, `/` — 200. Запрос идёт на `127.0.0.1:443`, но сертификат проверяется по имени домена;
8. записать `deploy/state/current` (прежний — в `previous`) и строку в `history`.

Ошибка на шагах 2–7 — те же шаги для прежнего тега и выход с кодом 1.

Миграции **не откатываются**: после отката работает прежний код на новой схеме. Поэтому CI
(`tools/ci/migration-lint.ts`) не пропускает в новых миграциях DROP, RENAME, `ADD COLUMN … NOT NULL` без DEFAULT,
`SET NOT NULL` и правку уже существующих файлов миграций. Когда это действительно нужно и безопасно (колонку давно
никто не читает; ограничение заменяется более широким) — разрешить в самом файле, с причиной:

```sql
-- migration-lint: allow drop — check заменяется более широким ниже, прежний код пишет только старые значения
```

Удаление колонки — в два выката: сначала код перестаёт её читать и писать, следующим выкатом — миграция с DROP.

Полезное на сервере:

```bash
/opt/relay/deploy/status.sh                       # версии, здоровье, OpenBao, сроки сертификатов, диск
/opt/relay/deploy/compose.sh ps
/opt/relay/deploy/compose.sh logs -f --tail=100 server worker
```

## Откат

- **GitHub:** Actions → deploy → Run workflow, `tag` = полный sha нужной версии (из `deploy/state/history`, списка
  коммитов master или Summary прошлых запусков). CI и сборка пропускаются — образы с этим тегом уже в GHCR; на
  сервер уходит `rollback <sha>`, затем та же проверка в браузере.
- **На сервере:** `deploy/rollback.sh` — на `deploy/state/previous`; `deploy/rollback.sh <sha>` — на указанную.
  Тот же путь, что выкат, но без автоматического «отката отката».

## После перезагрузки: распечатать OpenBao

Docker поднимет все контейнеры сам, но OpenBao стартует запечатанным: пока его не распечатать, сервис ключей не
разворачивает ключи чатов — Relay не открывает переписку, `deploy.sh` откажется выкатывать.

```bash
ssh -t deploy@denigram.site /opt/relay/deploy/bao-unseal.sh
```

Скрипт спросит ключ распечатки (ввод в приглашение самого `bao` в контейнере, без эха — ключ не проходит через
скрипт, аргументы или историю shell) — нужно два из трёх, — затем `up -d` для всего стека. Проверка —
`deploy/status.sh` (`openbao state: unsealed`).

## Бэкапы

`deploy/backup.sh` (cron выше) кладёт в `/srv/relay-backups` и, если заданы, копирует в `BACKUP_RCLONE_*`:

| Файл | Что | Ключ age | Хранится локально |
|---|---|---|---|
| `data/relay-data-*.dump.age` | Postgres без схемы keys (переписка — шифром) | `AGE_DATA` | 30 дней |
| `keys/relay-keys-*.dump.age` | Postgres, схема keys (ключи чатов, завёрнутые главным ключом) | `AGE_KEYS` | 7 дней |
| `keys/relay-bao-*.snap.age` | снимок raft OpenBao (главный ключ; без ключей распечатки бесполезен) | `AGE_KEYS` | 90 дней |
| `data/relay-s3-*.tar.age` | `/srv/relay-s3` (вложения, каждое — своим ключом) | `AGE_DATA` | 3 дня (`BACKUP_S3=0` — не делать) |

Дампы идут в age потоком — расшифрованное на диск не ложится. Части data и keys — разными ключами и в разные места
(смысл — в `tools/backup/pg-backup.sh`: удалённый чат через 7 дней не открыть ни из какого бэкапа).

Настройка:

1. на своей машине — два ключа: `age-keygen -o relay-data.key`, `age-keygen -o relay-keys.key`. Открытые части
   (`age1…`, не секрет) — в `.env` как `AGE_DATA` и `AGE_KEYS`. Закрытые — **не на сервере**, в разных местах;
2. копии вне сервера: `sudo -u deploy rclone config` (например, B2/S3/SFTP), в `.env` —
   `BACKUP_RCLONE_DATA=remote:relay-backups/data`, `BACKUP_RCLONE_KEYS=other-remote:relay-keys`. Скрипт делает
   `rclone copy` (только добавляет); удаление старых — правилом жизненного цикла хранилища;
3. проверить руками: `sudo -u deploy /opt/relay/deploy/backup.sh` и посмотреть файлы.

### Восстановление

Расшифровывать — на своей машине или временно скопировав закрытый ключ на сервер (и удалив после).

**Postgres** (на пустую базу; стек остановлен, кроме postgres):

```bash
cd /opt/relay
deploy/compose.sh stop server worker keys
age -d -i relay-data.key relay-data-<stamp>.dump.age > data.dump
age -d -i relay-keys.key relay-keys-<stamp>.dump.age > keys.dump
deploy/compose.sh exec -T postgres pg_restore -U relay -d relay --clean --if-exists < data.dump
deploy/compose.sh exec -T postgres pg_restore -U relay -d relay --clean --if-exists < keys.dump
shred -u data.dump keys.dump
deploy/compose.sh up -d
```

**OpenBao** (тот же главный ключ — иначе ключи чатов из бэкапа не развернуть). Снимок raft восстанавливается в
запущенный OpenBao токеном root; на новом сервере (или после потери тома) — так:

```bash
deploy/compose.sh up -d openbao
# временный init — только чтобы получить root-токен для restore; его ключи потом не нужны
deploy/compose.sh exec -T openbao bao operator init -key-shares=1 -key-threshold=1 -format=json > /root/tmp-init.json
jq -r '.unseal_keys_b64[0]' /root/tmp-init.json | deploy/compose.sh exec -T openbao bao write sys/unseal key=-
age -d -i relay-keys.key relay-bao-<stamp>.snap.age > bao.snap
BAO_TOKEN=$(jq -r .root_token /root/tmp-init.json) deploy/compose.sh exec -T -e BAO_TOKEN openbao \
  sh -c 'cat > /tmp/r.snap && bao operator raft snapshot restore -force /tmp/r.snap; rm -f /tmp/r.snap' < bao.snap
shred -u bao.snap /root/tmp-init.json
deploy/compose.sh restart openbao && deploy/bao-unseal.sh   # ключи распечатки — ПРЕЖНИЕ (2 из 3), из снимка
```

После restore в хранилище всё прежнее: ключ transit, политики и токены — `vault_token` и `bao_backup_token` из
прежних `secrets/run` снова действуют (если не истекли). Проверено: шифр, сделанный до бэкапа, расшифровывается прежним
токеном в OpenBao, восстановленном из снимка; временные ключи после restore уже не подходят, прежние — да.
Откатить хранилище работающего OpenBao (он жив, но испорчен) — root-токен через `bao operator generate-root`
прежними ключами, дальше тот же `snapshot restore -force` и отзыв этого root-токена.

**Вложения:**

```bash
deploy/compose.sh stop s3
age -d -i relay-data.key relay-s3-<stamp>.tar.age | docker run --rm -i -v /srv/relay-s3:/d chrislusf/seaweedfs:4.48 sh -c 'tar -C /d -xf -'
deploy/compose.sh up -d s3
```

Индекс поиска (том `meili`) не бэкапится: worker перестроит его сам.

Восстановление стоит проверять — раз в квартал развернуть бэкап на временной машине.

## Сертификаты: сроки

- домен — certbot продлевает сам (за 30 дней), хук перечитывает nginx;
- внутренние — **1 год**. `deploy/status.sh` показывает сроки. Перевыпуск (CA сохраняется):
  `deploy/certs.sh && deploy/compose.sh up -d --force-recreate`, затем `deploy/bao-unseal.sh` (OpenBao
  перезапустился — запечатан).

## Что ещё не сделано

- **canary** — позже, поверх этого CD, когда будет наблюдаемость: сейчас `up -d` пересоздаёт server/worker/proxy
  за секунды, клиенты переподключаются;
- TURN по TLS (`5349`, `turn.denigram.site`) — порт в firewall открыт, coturn пока без TLS-листенера;
- один сервер: OpenBao, Postgres и S3 на той же машине — бэкапы вне сервера обязательны;
- проверка типов `apps/server` и `packages/sync-engine` в CI: у пакетов нет tsconfig, а строгая проверка сейчас
  находит 79 и 107 ошибок — сначала их исправить, потом добавить в задание `typecheck`. `packages/relay-ui` —
  JavaScript без проверки типов.
