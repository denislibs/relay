-- Ключ поиска: индекс Meilisearch хранит не текст, а HMAC-токены слов (search/tokens.ts). Ключ один на систему,
-- в базе — только завёрнутый главным ключом KMS (как ключи чатов); бэкап — вместе со схемой keys (7 дней).
create table if not exists keys.search_key (
  id int primary key default 1 check (id = 1),
  wrapped bytea not null,
  kek_id text not null,
  created_at timestamptz not null default now()
);
