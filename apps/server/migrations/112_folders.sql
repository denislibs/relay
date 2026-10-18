-- Папки с чатами: упорядоченный массив папок пользователя (модель — packages/protocol/src/folders.ts).
-- Общие для всех устройств; правки — по одной папке, порядок — отдельно (domain/settings.ts).
alter table user_settings add column if not exists folders jsonb not null default '[]';
