-- сохранённые GIF пользователя (domain/savedGifs.ts): только ссылка на вложение, ключ файла здесь не хранится — он один,
-- в keys.attachment_keys, поэтому уничтожается как обычно: последняя ссылка ушла — ключа нет ни у кого.
-- thumb — миниатюра из сообщения, шифром ключа файла (fileKeys.sealThumb): умирает вместе с ключом и не лежит открытой.
create table if not exists saved_gifs (
  user_id       bigint not null references users(id) on delete cascade,
  attachment_id uuid not null references attachments(id) on delete cascade,
  thumb         bytea,
  saved_at      timestamptz not null default now(),
  primary key (user_id, attachment_id)
);
create index if not exists saved_gifs_recent on saved_gifs (user_id, saved_at desc);
-- сборка мусора и fileFor спрашивают «кто ссылается на файл»
create index if not exists saved_gifs_attachment on saved_gifs (attachment_id);
-- копия GIF loop (jobs/photo.ts): немой зацикленный H.264 для плиток панели — его можно поставить на паузу, в отличие от <img>
alter table attachment_variants drop constraint if exists attachment_variants_name_check;
alter table attachment_variants add constraint attachment_variants_name_check check (name in ('preview', '720', 'medium', 'loop'));
