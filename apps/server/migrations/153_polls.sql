-- опросы и викторины: определение — в messages.poll (как чек-лист, шифром в content), голоса — отдельно
alter table messages add column if not exists poll jsonb;
create table if not exists poll_votes (
  chat_id bigint not null,
  message_id bigint not null,
  user_id bigint not null references users(id) on delete cascade,
  option_id smallint not null,
  at timestamptz not null default now(),
  primary key (chat_id, message_id, user_id, option_id),
  foreign key (chat_id, message_id) references messages(chat_id, id) on delete cascade
);
-- «кто голосовал за вариант» (неанонимный опрос) и счётчики по варианту
create index if not exists poll_votes_option on poll_votes (chat_id, message_id, option_id, at);
create index if not exists poll_votes_user on poll_votes (user_id);
