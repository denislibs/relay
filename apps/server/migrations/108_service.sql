-- Служебный чат: системный пользователь «Relay», личный чат с ним у каждого, коды входа, подтверждение сеансов.
alter table users add column if not exists system boolean not null default false;
insert into users (name, system) select 'Relay', true where not exists (select 1 from users where system);
create unique index if not exists users_one_system on users (system) where system;

create table if not exists service_chats (
  user_id bigint primary key references users on delete cascade,
  chat_id bigint not null unique references chats on delete cascade
);

-- машинный тип служебного сообщения: login_code, new_login; у обычных — null
alter table messages add column if not exists service_type text;

create table if not exists login_attempts (
  id uuid primary key,
  user_id bigint not null references users on delete cascade,
  code_hash text not null,
  tries int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists login_attempts_user on login_attempts (user_id, created_at desc);

-- null — сеанс ещё не подтверждён (вход по коду); старые сеансы считаем подтверждёнными
alter table sessions add column if not exists confirmed_at timestamptz;
update sessions set confirmed_at = created_at where confirmed_at is null;
