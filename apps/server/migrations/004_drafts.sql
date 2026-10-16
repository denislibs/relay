-- черновики: один на пользователя и чат; меняются событием 'draft' в журнале пользователя (все его устройства)
create table if not exists drafts (
  user_id bigint not null references users(id) on delete cascade,
  chat_id bigint not null references chats(id) on delete cascade,
  text text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, chat_id)
);
