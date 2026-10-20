-- 134_chat_flags.sql: закреплённые, архив и пометка «непрочитанное» — настройки участника (одни на все устройства), как в Telegram
alter table chat_members add column if not exists pinned_at timestamptz;                  -- закреплён (порядок: позже закреплённый — выше); null — нет
alter table chat_members add column if not exists archived boolean not null default false; -- в архиве: не в «Все» и папках, а под строкой «Архив»
alter table chat_members add column if not exists unread_mark boolean not null default false; -- «Отметить как непрочитанное» (снимается при прочтении)
create index if not exists chat_members_pinned on chat_members (user_id) where pinned_at is not null;
create index if not exists chat_members_archived on chat_members (user_id) where archived;
