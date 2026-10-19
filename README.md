# Relay

Офлайн-first мессенджер: Bun + Postgres на сервере, Preact + UI-кит Relay на клиенте. Всё запускается в Docker.

```bash
./docker/nginx/dev-cert.sh         # один раз: сертификат https://localhost (нужен mkcert и `mkcert -install`)
docker compose up --build          # nginx на https://localhost (+ S3 на :8333) → Bun (API) + postgres, миграции, горячая перезагрузка
docker compose --profile test run --rm test        # серверные тесты на базе relay_test и бакете relay-test
docker compose --profile test run --rm test-engine # тесты движка синхронизации (fake-indexeddb + настоящий сервер)
docker compose --profile test run --rm test bun test test/e2e.test.ts   # один файл
docker compose --profile tools run --rm migrate-files   # перенос вложений со старого тома /data/files в бакет
docker compose --profile tools run --rm migrate-files bun apps/server/src/migrateFiles.ts --dry-run   # только посчитать
docker compose down -v             # остановить и удалить данные
```

Dev-вход (`DEV_LOGIN=1`): `POST /dev/login {"name":"Анна"}` → cookie `relay_session`; `POST /dev/chats {"kind":"direct","title":null,"memberIds":[2]}`; WebSocket `/ws` (кадры `hello`, `sync`, `send`, `read`, `ping`).

Вложения лежат в S3-совместимом хранилище (SeaweedFS, бакет `relay-files`, ключ — id вложения): клиент берёт подписанный PUT у `POST /uploads`, кладёт файл прямо в хранилище и подтверждает `POST /uploads/:id/confirm` (сервер сверяет размер и тип по HEAD). `GET /files/:id` проверяет доступ и отвечает 302 на подписанный GET на 10 минут. Браузер ходит в хранилище по `S3_PUBLIC_ENDPOINT`. Подробности: `docs/plans/2026-10-18-s3-storage.md`.

Вход — nginx (`docker/nginx/dev.conf`): https, клиент из `apps/web/dist` со сжатием gzip/brotli, всё, чего нет в сборке, — в Bun (API и `/ws`), `:8333` — в S3. Bun статику не раздаёт и наружу не открыт.

Как всё устроено — [ARCHITECTURE.md](ARCHITECTURE.md). Планы: `docs/plans/`.

## Пакеты

- `apps/server` — Bun + Postgres: журнал изменений, send/sync/read, WebSocket, LISTEN/NOTIFY.
- `packages/protocol` — типы кадров и изменений.
- `packages/sync-engine` — движок клиента: Store на IndexedDB, синхронизация, очередь отправки, прочтение, подписки с патчами; хосты SharedWorker и Dedicated Worker (лидер по Web Locks), `EngineClient` и `Mirror` для главного потока.
