-- когда пользователь последний раз был в сети (момент, когда закрылось его последнее соединение)
alter table users add column if not exists last_seen_at timestamptz;
