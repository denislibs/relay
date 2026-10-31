-- Кэш превью ссылок без открытого текста (аудит 2026-10-25, CRYPTO-4): ключ — HMAC адреса (url_hash, ключ поиска
-- из KMS), данные — шифр (sealed). Прежние открытые адрес и данные стираются: строки остаются только ради photo_id —
-- доступа к уже показанным картинкам превью (files.ts fileFor). Кэш наполнится заново.
alter table link_previews add column if not exists url_hash text;
alter table link_previews add column if not exists sealed bytea;
alter table link_previews drop constraint if exists link_previews_pkey;
alter table link_previews alter column url drop not null;
update link_previews set url_hash = 'legacy-' || gen_random_uuid()::text, url = null, data = null where url_hash is null;
alter table link_previews alter column url_hash set not null;
create unique index if not exists link_previews_url_hash on link_previews (url_hash);
create index if not exists link_previews_fetched on link_previews (fetched_at);
