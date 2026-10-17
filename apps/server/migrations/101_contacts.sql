-- Контакты: имя, которое дал владелец (видно только ему), и заметка. Односторонние: A добавил B — B об этом не знает.
create table if not exists contacts (
  owner_id   bigint not null references users on delete cascade,
  user_id    bigint not null references users on delete cascade,
  first_name text not null,
  last_name  text not null default '',
  note       text not null default '' check (char_length(note) <= 128),
  created_at timestamptz not null default now(),
  primary key (owner_id, user_id),
  check (owner_id <> user_id)
);
-- «у кого этот человек в контактах» — зрители профиля и присутствия
create index if not exists contacts_user_id on contacts (user_id);

-- Чёрный список (используется с B6)
create table if not exists blocks (
  owner_id   bigint not null references users on delete cascade,
  user_id    bigint not null references users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, user_id),
  check (owner_id <> user_id)
);
create index if not exists blocks_user_id on blocks (user_id);
