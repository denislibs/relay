-- Звонок без группы — «конференция» (domain/groupCalls.ts, этап 8): из разговора 1:1 («Добавить участника») или по
-- ссылке. chat_id пустой, kind = conference. Кто был в звонке — group_call_members (для списка «Звонки»).
-- Ссылки-приглашения в звонок (и в звонок группы — для тех, кто не в ней): хранится хэш токена, ссылку можно отозвать;
-- живёт, пока идёт звонок.
alter table group_calls alter column chat_id drop not null;
alter table group_calls add column if not exists kind text not null default 'chat' check (kind in ('chat', 'conference'));
create table if not exists group_call_members (
  call_id    uuid not null references group_calls on delete cascade,
  user_id    bigint not null references users on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (call_id, user_id)
);
create index if not exists group_call_members_user on group_call_members (user_id, joined_at desc);
create table if not exists group_call_links (
  token_hash  text primary key,
  call_id     uuid not null references group_calls on delete cascade,
  created_by  bigint references users on delete set null,
  approval    boolean not null default false,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index if not exists group_call_links_call on group_call_links (call_id);
