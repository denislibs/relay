-- непрочитанные реакции на мои сообщения (кнопка «сердце» над «вниз», как в Telegram): строка на сообщение, пока
-- не увижу его на экране или не нажму «прочитать все»; снимается и когда чужих реакций на нём не осталось
create table unread_reactions (
  user_id    bigint not null references users(id) on delete cascade,
  chat_id    bigint not null references chats(id) on delete cascade,
  message_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (user_id, chat_id, message_id)
);
create index unread_reactions_msg on unread_reactions (chat_id, message_id);
