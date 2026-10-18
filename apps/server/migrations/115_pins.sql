-- закреплённые сообщения чата (как в Telegram): видны всем участникам; удалённое сообщение снимается с закрепа
create table if not exists pinned_messages (
  chat_id    bigint not null,
  message_id bigint not null,
  pinned_by  bigint not null references users(id) on delete cascade,
  pinned_at  timestamptz not null default now(),
  primary key (chat_id, message_id),
  foreign key (chat_id, message_id) references messages(chat_id, id) on delete cascade
);
