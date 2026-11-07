-- «Войти через Telegram» (domain/telegramLogin.ts): браузер получает одноразовую ссылку t.me/<бот>?start=<токен>,
-- бот подтверждает номер контактом (свой, не пересланный) или кнопкой «Войти как …» у уже связанного аккаунта Telegram.
-- В базе только хэш токена; device_key — ключ устройства, начавшего вход: забрать вход опросом может только оно.
create table if not exists telegram_logins (
  id          uuid primary key,
  token_hash  text not null unique,
  device_key  bytea,
  ip          text,
  tg_user_id  bigint,                         -- кто открыл ссылку (/start): дальше попытку ведёт только он
  phone       text,                           -- номер из контакта (или связки) — после подтверждения
  status      text not null default 'wait',   -- wait | approved | denied | used
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists telegram_logins_ip on telegram_logins (ip, created_at);
create index if not exists telegram_logins_tg on telegram_logins (tg_user_id, created_at);

-- связка аккаунта Telegram с номером, подтверждённым контактом: повторный вход — кнопкой, коды входа — сюда (этап 2).
-- Номер — у одного аккаунта Telegram: новое подтверждение того же номера другим аккаунтом заменяет связку.
create table if not exists telegram_links (
  tg_user_id  bigint primary key,
  chat_id     bigint not null,
  phone       text not null unique,
  verified_at timestamptz not null default now()
);

-- смещение getUpdates (режим опроса, dev и сервер без входящего HTTPS)
create table if not exists telegram_state (
  k text primary key,
  v bigint not null
);
