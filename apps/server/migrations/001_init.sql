create table users (
  id          bigint generated always as identity primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table sessions (
  token_hash  text primary key,
  user_id     bigint not null references users on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create table chats (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('direct', 'group')),
  title       text,
  created_at  timestamptz not null default now()
);

create table chat_members (
  chat_id       bigint not null references chats on delete cascade,
  user_id       bigint not null references users on delete cascade,
  role          text not null default 'member',
  last_read_id  bigint not null default 0,
  joined_at     timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index chat_members_user on chat_members (user_id);

create table messages (
  chat_id      bigint not null references chats on delete cascade,
  id           bigint generated always as identity,
  sender_id    bigint not null references users,
  client_id    uuid not null,
  kind         text not null default 'text',
  body         text not null,
  reply_to_id  bigint,
  created_at   timestamptz not null default now(),
  primary key (chat_id, id),
  unique (sender_id, client_id)
);
create index messages_chat_id_desc on messages (chat_id, id desc);

create table user_seq (
  user_id  bigint primary key references users on delete cascade,
  seq      bigint not null
);

create table updates (
  user_id     bigint not null references users on delete cascade,
  seq         bigint not null,
  type        text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, seq)
);
