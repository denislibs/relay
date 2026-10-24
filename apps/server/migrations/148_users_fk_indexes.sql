-- Внешние ключи на users без индекса: удаление пользователя (и chat.purge) проверяло их seq-скан на каждую строку —
-- на 200 000 участников это часы. Индексы под проверку FK.
create index if not exists chat_members_inviter on chat_members (inviter_id) where inviter_id is not null;
create index if not exists chat_members_promoted_by on chat_members (promoted_by) where promoted_by is not null;
create index if not exists chats_owner on chats (owner_id) where owner_id is not null;
create index if not exists pinned_messages_pinned_by on pinned_messages (pinned_by) where pinned_by is not null;
create index if not exists chat_bans_banned_by on chat_bans (banned_by) where banned_by is not null;
create index if not exists chat_invites_creator on chat_invites (creator_id) where creator_id is not null;
