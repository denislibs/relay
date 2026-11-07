-- Групповые звонки (domain/groupCalls.ts): история — когда начат, кем, когда закончился и сколько длился.
-- Идущий звонок и его состав — в Valkey; здесь — только то, что должно пережить перезапуск.
create table if not exists group_calls (
  id          uuid primary key,
  chat_id     bigint not null references chats on delete cascade,
  started_by  bigint references users on delete set null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  duration    integer
);
create index if not exists group_calls_chat on group_calls (chat_id, started_at desc);
-- не больше одного идущего звонка на группу
create unique index if not exists group_calls_active on group_calls (chat_id) where ended_at is null;
