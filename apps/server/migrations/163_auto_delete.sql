-- Автоудаление сообщений: срок чата в секундах (null — выключено). Срок сообщения ставит сервер при публикации из настройки
-- чата на этот момент и больше не двигает. Индексы — только по живым сообщениям со сроком: их мало, задача messages.expire
-- и уничтожение ключей ходят только по ним.
alter table chats add column if not exists auto_delete_sec integer;
alter table messages add column if not exists expires_at timestamptz;
create index if not exists messages_expiring on messages (expires_at) where expires_at is not null and not deleted;
create index if not exists messages_expiring_chat on messages (chat_id, expires_at) where expires_at is not null and not deleted;

-- Срочные ключи чата (crypto/chatKeys.ts): сообщение со сроком шифруется ключом суточной корзины своего срока. Когда корзина
-- прошла, ключ уничтожается (messages.expire) — содержимое не открыть и из бэкапа данных. Номера — из отдельной последовательности
-- выше обычных версий и не повторяются: уничтоженный номер никогда не достанется другому ключу.
alter table keys.chat_keys add column if not exists expires_at timestamptz;
create sequence if not exists keys.expiring_key_version minvalue 1073741824 start 1073741824;
create unique index if not exists chat_keys_expiring on keys.chat_keys (chat_id, expires_at) where expires_at is not null;
create index if not exists chat_keys_expiry on keys.chat_keys (expires_at) where expires_at is not null;
