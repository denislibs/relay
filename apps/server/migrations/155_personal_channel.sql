-- личный канал в профиле: публичный канал, которым пользователь владеет; показывается тем, кто видит профиль.
-- Канал стал приватным, сменил владельца или удалён — groups.ts обнуляет поле (индекс — для этого поиска по каналу)
alter table users add column if not exists personal_channel_id bigint references chats(id) on delete set null;
create index if not exists users_personal_channel_idx on users (personal_channel_id) where personal_channel_id is not null;
