-- Завёрнутые ключи привязаны к назначению (crypto/keyBinding.ts, аудит 2026-10-25, CRYPTO-5). bound = false — ключ
-- старого формата (без метки): задача crypto.bind перезаворачивает такие с меткой.
alter table keys.chat_keys add column if not exists bound boolean not null default false;
alter table keys.attachment_keys add column if not exists bound boolean not null default false;
alter table keys.search_key add column if not exists bound boolean not null default false;
