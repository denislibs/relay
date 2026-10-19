-- обработка видео в воркере (jobs/video.ts): копии лежат отдельными объектами рядом с оригиналом.
-- preview — первые секунды без звука, 360p, до 1 МБ (играет в ленте); '720' — H.264 720p (просмотрщик по умолчанию).
create table if not exists attachment_variants (
  attachment_id uuid not null references attachments(id) on delete cascade,
  name          text not null check (name in ('preview', '720')),
  key           text not null,            -- ключ объекта в бакете
  mime          text not null,
  size          bigint not null,
  width         int not null,
  height        int not null,
  primary key (attachment_id, name)
);
-- оригинал после faststart-перепаковки лежит под другим ключом (старый удаляется позже: по нему ещё могут играть);
-- null — ключ = id. processed: done — копии сделаны, skipped — воркер не смог разобрать файл (играет оригинал как есть)
alter table attachments add column if not exists storage_key text;
alter table attachments add column if not exists processed text;
alter table attachments drop constraint if exists attachments_processed;
alter table attachments add constraint attachments_processed check (processed in ('done', 'skipped'));
