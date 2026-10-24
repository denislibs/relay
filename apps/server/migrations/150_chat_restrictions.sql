-- Ограничения участника группы переживают выход (иначе ограниченный вышел бы и писал гостем треда с правами по
-- умолчанию или вернулся по ссылке «чистым»): исключение прав и граница скрытой истории — до возвращения
create table if not exists chat_restrictions (
  chat_id bigint not null references chats(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  restricted jsonb,
  history_from bigint not null default 0,
  primary key (chat_id, user_id)
);
create index if not exists chat_restrictions_user on chat_restrictions (user_id);
