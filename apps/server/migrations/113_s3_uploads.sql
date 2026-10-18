-- вложения в S3 (ключ объекта = id): клиент кладёт файл по подписанному PUT, сервер подтверждает по HEAD.
-- pending — запись есть, объект ещё не проверен (отправить нельзя); ready — размер и тип совпали.
-- Прежние строки — файлы с тома /data/files (перенос: apps/server/src/migrateFiles.ts), они уже ready.
alter table attachments add column if not exists status text not null default 'ready';
alter table attachments add constraint attachments_status check (status in ('pending', 'ready'));
create index if not exists attachments_pending on attachments (created_at) where status = 'pending';
