-- Альбом поста (общий group_id) — один тред на все его посты: строки message_threads постов альбома указывают на
-- копию первого. Поиск первого поста альбома и всех постов треда — по индексам, не перебором канала.
create index messages_album on messages (chat_id, group_id, id) where group_id is not null;
create index message_threads_copy on message_threads (chat_id, copy_id);
