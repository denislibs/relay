-- Цитата части сообщения в ответе: сам фрагмент лежит только в шифре (messages.content). Открытый признак нужен, чтобы при
-- удалении исходного найти ответы, где живёт его кусок, и вычистить его (messageOps.erase): иначе удалённый текст переживал бы
-- своё сообщение. Индекс — только по таким ответам, их мало.
alter table messages add column if not exists has_quote boolean not null default false;
create index if not exists messages_quote_replies on messages (chat_id, reply_to_id) where has_quote;
