-- Группа обсуждения: «Комментировать могут только участники» (join_to_send в Telegram). Выключено — подписчик канала
-- читает тред и комментирует, не вступая в группу (threads.ts threadAccess); включено — сначала вступить.
alter table chats add column if not exists join_to_send boolean not null default false;
