-- 131_chat_mute.sql: выключенные уведомления чата — настройка аккаунта (одна на все устройства), как в Telegram
alter table chat_members add column if not exists mute_until timestamptz;   -- null — включены; 'infinity' — навсегда
