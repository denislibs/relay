-- Группа обсуждения: «Комментировать могут только участники» (join_to_send в Telegram). Выключено — подписчик канала
-- читает тред и комментирует, не вступая в группу (threads.ts threadAccess); включено — сначала вступить.
alter table chats add column if not exists join_to_send boolean not null default false;
-- Гость треда видит профили комментаторов (users.ts usersByIds): автор комментария в группе обсуждения — по индексу
create index if not exists messages_commenter on messages (sender_id, chat_id) where thread_id is not null;
