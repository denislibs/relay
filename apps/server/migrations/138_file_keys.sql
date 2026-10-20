-- вложения, зашифрованные на клиенте (packages/protocol/src/fileCrypto.ts): ключ файла — в схеме keys, только завёрнутым
-- главным ключом KMS; файл удалён (сборка мусора) — ключ уходит каскадом. enc = 1 — объект в хранилище шифром;
-- size остаётся исходным (объект больше: заголовок и теги кусков). Имя, название и исполнитель — шифром в meta.
create table if not exists keys.attachment_keys (
  attachment_id uuid primary key references attachments(id) on delete cascade,
  wrapped       bytea not null,
  kek_id        text not null,
  created_at    timestamptz not null default now()
);
alter table attachments add column if not exists enc smallint not null default 0;
alter table attachments add column if not exists meta bytea;
create or replace function keys.notify_file_key_gone() returns trigger language plpgsql as $$
begin
  perform pg_notify('file_keys', old.attachment_id::text);
  return null;
end $$;
drop trigger if exists file_key_gone on keys.attachment_keys;
create trigger file_key_gone after delete on keys.attachment_keys for each row execute function keys.notify_file_key_gone();
