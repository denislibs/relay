-- Служебный чат: системный пользователь «Relay», личный чат с ним у каждого, коды входа, подтверждение сеансов.
-- Идемпотентна: на dev-базах, где уже применены старые 108_service/109_login_limits, выполняется повторно без вреда.
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

-- Лимиты кодов входа: попытки не удаляются при использовании (dead_at), считаются по нормализованному логину, IP и пользователю.
alter table login_attempts add column if not exists dead_at timestamptz;
alter table login_attempts add column if not exists login text not null default '';
alter table login_attempts add column if not exists ip text;
create index if not exists login_attempts_login on login_attempts (login, created_at desc);
create index if not exists login_attempts_ip on login_attempts (ip, created_at desc) where ip is not null;

-- null — сеанс ещё не подтверждён (вход по коду передаёт null явно); по умолчанию сеанс подтверждён.
-- Старые сеансы считаем подтверждёнными с момента создания — только когда столбец появляется впервые,
-- иначе повторный прогон подтвердил бы ждущие входы по коду.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = current_schema() and table_name = 'sessions' and column_name = 'confirmed_at') then
    alter table sessions add column confirmed_at timestamptz;
    update sessions set confirmed_at = created_at;
  end if;
end $$;
alter table sessions alter column confirmed_at set default now();
