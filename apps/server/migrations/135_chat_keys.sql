-- ключи чатов (DEK) — отдельная схема: её бэкапят отдельно и коротко, чтобы удалённый ключ не жил в старых бэкапах.
-- Ключ хранится только завёрнутым главным ключом из KMS (kek_id — каким). Чат удалён — его ключи уходят каскадом.
create schema if not exists keys;
create table if not exists keys.chat_keys (
  chat_id     bigint not null references chats(id) on delete cascade,
  version     int not null,
  wrapped_dek bytea not null,
  kek_id      text not null,
  created_at  timestamptz not null default now(),
  primary key (chat_id, version)
);
