-- сеанс, привязанный к ключу устройства (как DBSC): при первом обновлении доступа браузер присылает публичный ключ
-- ECDSA P-256 (закрытый неизвлекаем, в IndexedDB) — он запоминается у сеанса. Дальше обычные запросы ходят с коротким
-- cookie доступа (session_access, 10 минут), а получить новый можно только подписью ключом устройства; долгий cookie
-- сеанса один ничего не открывает. Унесли оба cookie вместе с профилем — хватит на минуты, а WebSocket не откроется.
alter table sessions add column if not exists device_key bytea;
alter table sessions add column if not exists bound_at timestamptz;
create table if not exists session_access (
  token_hash text primary key,
  session_id bigint not null references sessions(id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists session_access_session on session_access (session_id);
