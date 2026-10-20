-- ключ чата удалён (чат удалён, «удалить у обоих», уничтожение старых версий) — каждый процесс сервера и воркера
-- забывает его в памяти сразу, а не через 10 минут кэша (crypto/keyEvents.ts слушает канал chat_keys)
create or replace function keys.notify_chat_key_gone() returns trigger language plpgsql as $$
begin
  perform pg_notify('chat_keys', old.chat_id::text);
  return null;
end $$;
drop trigger if exists chat_key_gone on keys.chat_keys;
create trigger chat_key_gone after delete on keys.chat_keys for each row execute function keys.notify_chat_key_gone();
