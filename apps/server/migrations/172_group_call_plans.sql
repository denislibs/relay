-- Запланированные групповые звонки (domain/groupCalls.ts): один план на группу; кто нажал «Напомнить» — напоминание
-- в срок (пуш, если вкладок нет; открытая вкладка напоминает сама по времени плана). Название звонка — и у идущего.
alter table group_calls add column if not exists title text;
create table if not exists group_call_plans (
  id          uuid primary key,
  chat_id     bigint not null unique references chats on delete cascade,
  created_by  bigint references users on delete set null,
  title       text,
  at          timestamptz not null,
  created_at  timestamptz not null default now()
);
create table if not exists group_call_reminders (
  plan_id  uuid not null references group_call_plans on delete cascade,
  user_id  bigint not null references users on delete cascade,
  primary key (plan_id, user_id)
);
