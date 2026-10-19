-- Управление группой (как в Telegram): владелец, админы с правами, права участников и исключения,
-- удалённые, ссылки-приглашения, заявки, тип (публичная/частная), реакции, история для новых.

alter table chats add column if not exists about          text;
alter table chats add column if not exists photo          jsonb;      -- {id, small, thumb, at} — как у профиля
alter table chats add column if not exists owner_id       bigint references users on delete set null;
alter table chats add column if not exists rights         jsonb;      -- права участников по умолчанию (разрешённое); null — все
alter table chats add column if not exists slow_mode      int not null default 0;
alter table chats add column if not exists history_hidden boolean not null default false;
alter table chats add column if not exists join_approval  boolean not null default false;
alter table chats add column if not exists username       text check (username ~ '^[a-z][a-z0-9_]{4,31}$');
alter table chats add column if not exists reactions      jsonb;      -- {mode: all|some|none, allowed: [...]}; null — все
alter table chats add column if not exists protected      boolean not null default false;
create unique index if not exists chats_username_lower on chats (lower(username)) where username is not null;

-- владелец старых групп — автор «создал(а) группу»
update chats c set owner_id = m.sender_id
  from messages m
 where c.kind = 'group' and c.owner_id is null and m.chat_id = c.id and m.service_type = 'group_created';
update chat_members cm set role = 'owner'
  from chats c where c.id = cm.chat_id and c.owner_id = cm.user_id and cm.role <> 'owner';

alter table chat_members add column if not exists admin_rights jsonb;     -- null — не админ
alter table chat_members add column if not exists rank         text;      -- звание, до 16 символов
alter table chat_members add column if not exists promoted_by  bigint references users on delete set null;
alter table chat_members add column if not exists restricted   jsonb;     -- исключение: разрешённое этому участнику; null — как у всех
alter table chat_members add column if not exists inviter_id   bigint references users on delete set null;
alter table chat_members add column if not exists history_from bigint not null default 0;   -- первое видимое сообщение

-- «Удалённые пользователи»: не вернуться ни по ссылке, ни по юзернейму, пока не разблокируют
create table if not exists chat_bans (
  chat_id    bigint not null references chats on delete cascade,
  user_id    bigint not null references users on delete cascade,
  banned_by  bigint references users on delete set null,
  at         timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create table if not exists chat_invites (
  id           bigserial primary key,
  chat_id      bigint not null references chats on delete cascade,
  token        text not null unique,
  creator_id   bigint references users on delete set null,
  title        text,
  expires_at   timestamptz,
  usage_limit  int,
  usage        int not null default 0,
  approval     boolean not null default false,
  revoked      boolean not null default false,
  primary_link boolean not null default false,   -- основная ссылка группы (одна активная)
  created_at   timestamptz not null default now()
);
create index if not exists chat_invites_chat on chat_invites (chat_id, id desc);

create table if not exists chat_invite_joins (
  invite_id   bigint not null references chat_invites on delete cascade,
  user_id     bigint not null references users on delete cascade,
  via_request boolean not null default false,
  at          timestamptz not null default now(),
  primary key (invite_id, user_id)
);

create table if not exists chat_join_requests (
  chat_id   bigint not null references chats on delete cascade,
  user_id   bigint not null references users on delete cascade,
  invite_id bigint references chat_invites on delete set null,
  at        timestamptz not null default now(),
  primary key (chat_id, user_id)
);

-- фото групп: видны всем, кто видит приглашение (как превью ссылки)
create table if not exists chat_photos (
  id         bigserial primary key,
  chat_id    bigint not null references chats on delete cascade,
  big        uuid not null,
  small      uuid not null,
  thumb      text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_photos_big on chat_photos (big);
create index if not exists chat_photos_small on chat_photos (small);

-- кто участвовал в служебном событии: [{id, name}] и прочее (имена на момент события)
alter table messages add column if not exists service_data jsonb;
