# Relay

Офлайн-first мессенджер: Bun + Postgres на сервере, Preact + UI-кит Relay на клиенте. Всё запускается в Docker.

```bash
docker compose up --build          # postgres + миграции + сервер на :3000 (горячая перезагрузка)
docker compose run --rm test       # все серверные тесты на базе relay_test
docker compose run --rm test bun test test/e2e.test.ts   # один файл
docker compose down -v             # остановить и удалить данные
```

Dev-вход (`DEV_LOGIN=1`): `POST /dev/login {"name":"Анна"}` → cookie `relay_session`; `POST /dev/chats {"kind":"direct","title":null,"memberIds":[2]}`; WebSocket `/ws` (кадры `hello`, `sync`, `send`, `read`, `ping`).

Планы: `docs/plans/`.
