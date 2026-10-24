-- Каналы (kind = 'channel'): пишут админы с правом post, подписчики читают. Одной миграцией и то, что нужно
-- следующим шагам (посты в обсуждение, просмотры, счётчики реакций, треды, упоминания).
alter table chats drop constraint chats_kind_check;
alter table chats add constraint chats_kind_check check (kind in ('direct', 'group', 'channel'));
alter table chats add column linked_chat_id bigint references chats(id) on delete set null,   -- канал ↔ группа обсуждения (обе строки)
                  add column signatures boolean not null default false,                       -- подписи авторов под постами
                  add column members_count int not null default 0;                            -- держит триггер ниже: строка списка без count(*)
update chats c set members_count = (select count(*) from chat_members m where m.chat_id = c.id);
-- мягкое удаление большого чата: с этого момента чат «пропал», строки убирает задача chat.purge страницами
alter table chats add column deleted_at timestamptz;

-- пост: sender_id — внутренняя правда (права, push), наружу автор не отдаётся; post_author — подпись на момент поста
alter table messages add column post boolean not null default false,
                     add column post_author text,
                     add column thread_id bigint,   -- комментарий: id копии поста в группе обсуждения
                     add column origin jsonb;       -- копия поста в группе: {chatId, id} оригинала
create index messages_thread on messages (chat_id, thread_id, id) where thread_id is not null;
create index messages_origin on messages ((origin->>'chatId'), (origin->>'id')) where origin is not null;

-- число участников — на всех путях вставки и удаления (createChat, createGroup, seed, service, openDirect, вступление, выход)
create or replace function chat_members_count() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update chats set members_count = members_count + 1 where id = new.chat_id;
  else
    update chats set members_count = members_count - 1 where id = old.chat_id;
  end if;
  return null;
end $$;
create trigger chat_members_count after insert or delete on chat_members for each row execute function chat_members_count();

create table message_views (
  chat_id    bigint not null references chats(id) on delete cascade,
  message_id bigint not null,
  views      int not null default 0,
  primary key (chat_id, message_id)
);
create table message_reaction_counts (
  chat_id    bigint not null references chats(id) on delete cascade,
  message_id bigint not null,
  emoji      text not null,
  n          int not null,
  primary key (chat_id, message_id, emoji)
);
-- тред поста: chat_id — канал, copy_id — копия поста в группе обсуждения
create table message_threads (
  chat_id bigint not null references chats(id) on delete cascade,
  post_id bigint not null,
  copy_id bigint not null,
  count   int not null default 0,
  last_id bigint,
  recent  bigint[] not null default '{}',
  primary key (chat_id, post_id)
);
create table thread_reads (
  user_id     bigint not null references users(id) on delete cascade,
  chat_id     bigint not null references chats(id) on delete cascade,
  thread_id   bigint not null,
  read_max_id bigint not null default 0,
  primary key (user_id, chat_id, thread_id)
);
create table message_mentions (
  user_id    bigint not null references users(id) on delete cascade,
  chat_id    bigint not null references chats(id) on delete cascade,
  message_id bigint not null,
  thread_id  bigint,
  primary key (user_id, chat_id, message_id)
);
create index message_mentions_msg on message_mentions (chat_id, message_id);
