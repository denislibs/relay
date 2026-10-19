-- большой файл грузится частями (S3 multipart): id загрузки в хранилище, пока вложение pending; после confirm — null
alter table attachments add column if not exists upload_id text;
