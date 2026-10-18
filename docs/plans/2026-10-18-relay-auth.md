# Вход в Relay — план

**Цель:** настоящий вход вместо dev-заглушки: телефон → код (служебный чат или dev), QR с подтверждением на вошедшем устройстве, облачный пароль на SRP, паскеи (WebAuthn), регистрация нового номера; свой персонаж-сова, которая следит за кодом и закрывает глаза на пароле.

**Основа:** ветка `feat/auth` от `feat/service-chat` (там уже есть системный пользователь, служебный чат, `POST /auth/code`, `POST /auth/signin`, лимиты). Экран кода (её Task 6) делаем здесь; её задачи 4, 5, 7, 8 — её.

**Исследование:** `docs/research/2026-10-18-auth-flow.md`.

## Global Constraints

- tweb/telegram-tt — GPL: только поведение. Код, CSS, Lottie/TGS, логотип Telegram не берём. Персонаж — своя SVG-сова.
- Новые зависимости — только MIT: `@simplewebauthn/server`, `@simplewebauthn/browser`, `libphonenumber-js`, кодировщик/декодер QR.
- Плавный UI: смена карточек out-in (уход: opacity→0, −24px; приход: +24px→0; 180/200ms); ошибки без тряски; лоадеры с задержкой показа и минимальным временем; без вспышек.
- `/dev/login` остаётся при `DEV_LOGIN=1` (тесты, Playwright).
- Каждый вход завершается `createSession` (устройство, IP, список сеансов уже работают).
- Миграции с номера 110. Тесты — `bun test` в Docker, всё зелёное перед коммитом.

## Контракты сервера

| Метод | Тело → ответ | Примечание |
|---|---|---|
| `GET /auth/config` | → `{dev, passkeys}` | dev — показывать dev-вход |
| `POST /auth/code` | `{login}` → `{attemptId, via, length, devCode?}` | есть (service-chat) |
| `POST /auth/signin` | `{attemptId, code}` → сеанс \| `{passwordNeeded, pendingId, hint}` \| `{signupRequired, pendingId}` | расширяем |
| `POST /auth/signup` | `{pendingId, firstName, lastName}` → сеанс | новый номер (без SMS — только dev) |
| `POST /auth/password/challenge` | `{pendingId}` → `{srpId, salt, B, hint}` | SRP-6a |
| `POST /auth/password/check` | `{pendingId, srpId, A, M1}` → сеанс | `password_invalid` |
| `POST /auth/password/recover` | `{pendingId}` → `{emailPattern}` | код на почту (dev — `/dev/codes`) |
| `POST /auth/password/recover/check` | `{pendingId, code}` → сеанс | снимает пароль |
| `POST /auth/qr` | → `{token, url, expiresAt}` | 30 с, хэш в базе |
| `POST /auth/qr/poll` | `{token}` → `{status: 'wait'\|'expired'}` \| сеанс \| `{passwordNeeded…}` | клиент опрашивает раз в 2 с |
| `GET /auth/qr/info?token` | → `{device, ip, createdAt}` | для «Войти на …?» (нужен сеанс) |
| `POST /auth/qr/accept` | `{token}` → `{ok}` | только подтверждённый сеанс |
| `POST /auth/passkey/options` | → `{id, options}` | без allowCredentials (discoverable) |
| `POST /auth/passkey/finish` | `{id, response}` → сеанс \| `{passwordNeeded…}` | `passkey_not_found` |
| `GET/PUT/DELETE /settings/password` | SRP-верификатор, подсказка, почта; смена/снятие — с SRP-доказательством текущего | |
| `GET /settings/passkeys`, `POST /settings/passkeys/options`, `POST /settings/passkeys`, `DELETE /settings/passkeys/:id` | регистрация и список | |
| `GET /dev/codes` | → последние коды (dev) | только `DEV_LOGIN=1` |

**SRP-6a:** группа RFC 5054 2048 бит, `H = SHA-256`, `k = H(N | pad(g))`, `x = PBKDF2-SHA512(пароль, salt, 100000) mod N`, `v = gˣ`. Сервер: `B = kv + gᵇ`. Клиент: `u = H(pad(A) | pad(B))`, `S = (B − k·gˣ)^(a + u·x)`, `M1 = H(pad(A) | pad(B) | pad(S))`. Сервер сверяет `M1` за постоянное время. Пароль и `x` на сервер не уходят.

## Файлы

```
apps/server/migrations/110_auth.sql          login_pending, user_passwords, srp_challenges, qr_logins, passkeys, webauthn_challenges
apps/server/src/domain/srp.ts                группа, modPow, проверка M1 (общая с клиентом математика — packages/protocol/src/srp.ts)
apps/server/src/domain/password.ts           pending, challenge/check, установка/смена/снятие, восстановление
apps/server/src/domain/qrLogin.ts            выдача, опрос, подтверждение
apps/server/src/domain/passkeys.ts           WebAuthn вход и регистрация
apps/server/src/domain/devOutbox.ts          кольцевой буфер dev-кодов
apps/server/src/authRoutes.ts                маршруты /auth/* и /settings/password|passkeys (http.ts остаётся тонким)
packages/protocol/src/srp.ts                 SRP: числа, pad, H, клиентский расчёт (браузер и тесты)
apps/web/src/ui/auth/AuthFlow.tsx            роутер карточек, переходы, sessionStorage
apps/web/src/ui/auth/{Phone,Qr,Code,Password,SignUp,Recover}Card.tsx
apps/web/src/ui/auth/CodeInput.tsx, CountryPicker.tsx, phone.ts
apps/web/src/ui/auth/api.ts                  вызовы /auth/*, единый разбор ответов
packages/relay-ui/src/owl.js                 сова: gaze/cover/peek, ожидание
apps/web/src/ui/settings/{Password,Passkeys}.tsx, Sessions.tsx (сканер QR), QrConfirm.tsx (#qr=)
```

## Задачи

1. **Сервер: pending-вход, регистрация, dev-коды.** Миграция 110; `signin` отдаёт `passwordNeeded`/`signupRequired`; `signup`; `/auth/config`; `/dev/codes`. Тесты: код → сеанс, код → нужен пароль, новый номер (dev) → регистрация, prod без SMS не создаёт пользователя.
2. **Сервер: SRP-пароль.** `packages/protocol/src/srp.ts`, установка/смена/снятие в настройках, вход вторым шагом, восстановление по почте (dev-outbox), лимиты на неверный пароль. Тесты: верный/неверный пароль, повтор srpId, смена с доказательством.
3. **Сервер: QR.** Выдача, опрос, info, accept (только подтверждённым сеансом), истечение, пароль после QR. Тесты.
4. **Сервер: паскеи.** `@simplewebauthn/server`; тесты регистрации и входа на сгенерированных ответах (виртуальный аутентификатор в тесте: ключ ES256 через WebCrypto).
5. **Клиент: карточки и переходы.** Телефон (страна с поиском, маска и серый хвост через libphonenumber-js, ссылки QR/паскей), код (клетки, автоотправка, таймер, «изменить номер»), пароль, регистрация, восстановление; продолжение после перезагрузки; переход в приложение кроссфейдом; dev-вход ссылкой.
6. **Сова.** SVG-риг в ките: зрачки и голова по `gaze`, крылья по `cover`, перья-«пальцы» по `peek`, моргание/дыхание; следящая на коде, закрытая на пароле.
7. **Настройки и подтверждения.** Облачный пароль, паскеи (вступление, список, создание, удаление), «Подключить устройство» со сканером, диплинк `#qr=` → «Войти на …?».
8. **Проверка целиком в браузере** (Playwright: два контекста; паскей — виртуальный аутентификатор CDP), слияние.
