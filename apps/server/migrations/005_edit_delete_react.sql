-- правка и удаление сообщений; реакции (одна от пользователя на сообщение)
alter table messages add column if not exists edited_at timestamptz;
alter table messages add column if not exists deleted boolean not null default false;
create table if not exists reactions (
  chat_id    bigint not null,
  message_id bigint not null,
  user_id    bigint not null references users(id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, message_id, user_id),
  foreign key (chat_id, message_id) references messages (chat_id, id) on delete cascade
);
