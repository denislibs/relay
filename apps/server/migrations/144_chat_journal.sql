-- Журнал на чат для групп и каналов: событие группы — одна запись, а не по записи каждому участнику в updates.
-- Инвариант тот же, что у личного журнала, но на чат: seq видимы по порядку и без дыр (строка chat_seq заперта до коммита).
create table chat_seq (
  chat_id    bigint primary key references chats(id) on delete cascade,
  seq        bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp()   -- для hello {since}: какие чаты менялись; без индекса — горячая строка
);
create table chat_updates (
  chat_id bigint not null references chats(id) on delete cascade,
  seq     bigint not null,
  type    text not null,
  payload jsonb not null,
  primary key (chat_id, seq)
);
insert into chat_seq (chat_id) select id from chats where kind <> 'direct';
-- граница архива: max(id) сообщений на момент архивирования; разархивирование группы — условная операция клиента (unarchive)
alter table chat_members add column archived_at_id bigint not null default 0;
update chat_members cm set archived_at_id = coalesce((select max(id) from messages m where m.chat_id = cm.chat_id), 0) where archived;
