-- Фото профиля: {id, small, thumb, at} — 640 и 160 (attachments) + крошечное превью data:URL, чтобы аватарка не мигала
alter table users add column if not exists photo jsonb;
-- fileFor ищет «это чьё-то фото профиля?» по id файла
create index if not exists users_photo_id on users ((photo->>'id')) where photo is not null;
create index if not exists users_photo_small on users ((photo->>'small')) where photo is not null;
