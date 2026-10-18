-- Вход: незавершённый вход (нужен пароль / регистрация), облачный пароль (SRP), QR, паскеи.

-- первый фактор пройден, но вход не закончен: нужен облачный пароль или регистрация нового номера
create table if not exists login_pending (
  id          uuid primary key,
  kind        text not null check (kind in ('password', 'signup')),
  user_id     bigint references users on delete cascade,   -- null у регистрации
  phone       text,                                        -- номер для регистрации
  confirmed   boolean not null default false,              -- сеанс после пароля: подтверждён ли (QR/паскей — да, код — нет)
  tries       int not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  dead_at     timestamptz
);
create index if not exists login_pending_user on login_pending (user_id, created_at desc);

-- облачный пароль: только SRP-верификатор (сам пароль на сервер не приходит)
create table if not exists user_passwords (
  user_id     bigint primary key references users on delete cascade,
  salt        text not null,             -- base64url
  verifier    text not null,             -- hex, v = g^x mod N
  hint        text not null default '',
  email       text,
  updated_at  timestamptz not null default now()
);

-- одноразовый SRP-вызов: секрет b сервера живёт минуту
create table if not exists srp_challenges (
  id          uuid primary key,
  user_id     bigint not null references users on delete cascade,
  b           text not null,             -- hex
  big_b       text not null,             -- hex
  expires_at  timestamptz not null
);

-- коды восстановления пароля по почте
create table if not exists password_recovery (
  pending_id  uuid primary key references login_pending on delete cascade,
  code_hash   text not null,
  tries       int not null default 0,
  expires_at  timestamptz not null
);

-- QR: токен показывает новое устройство, подтверждает вошедшее
create table if not exists qr_logins (
  token_hash  text primary key,
  device      text,
  ip          text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_id     bigint references users on delete cascade,    -- кто подтвердил
  accepted_at timestamptz,
  used_at     timestamptz
);

-- паскеи (WebAuthn): открытый ключ и счётчик подписи
create table if not exists passkeys (
  id            text primary key,          -- credential id, base64url
  user_id       bigint not null references users on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  name          text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists passkeys_user on passkeys (user_id);

create table if not exists webauthn_challenges (
  id          uuid primary key,
  challenge   text not null,
  user_id     bigint references users on delete cascade,   -- регистрация — чей ключ; вход — null
  expires_at  timestamptz not null
);
