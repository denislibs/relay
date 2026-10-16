-- вложения: файл на диске (FILES_DIR/<id>), метаданные здесь; сообщение хранит снимок метаданных
create table if not exists attachments (
  id         uuid primary key default gen_random_uuid(),
  owner_id   bigint not null references users(id) on delete cascade,
  mime       text not null,
  name       text not null,
  size       bigint not null,
  width      int,
  height     int,
  created_at timestamptz not null default now()
);
alter table messages add column if not exists attachment jsonb;
create index if not exists messages_attachment_id on messages ((attachment->>'id')) where attachment is not null;
