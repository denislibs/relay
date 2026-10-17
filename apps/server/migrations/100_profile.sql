-- Профиль: имя/фамилия, @username, о себе, день рождения, телефон. users.name остаётся отображаемым именем.
alter table users add column if not exists first_name text;
alter table users add column if not exists last_name  text;
alter table users add column if not exists username   text check (username ~ '^[a-z][a-z0-9_]{4,31}$');
alter table users add column if not exists bio        text check (char_length(bio) <= 140);
alter table users add column if not exists birthday   jsonb;
alter table users add column if not exists phone      text check (phone ~ '^\+[0-9]{7,15}$');

update users
   set first_name = split_part(name, ' ', 1),
       last_name  = nullif(btrim(substr(name, length(split_part(name, ' ', 1)) + 1)), '')
 where first_name is null;

create unique index if not exists users_username_lower on users (lower(username));
create unique index if not exists users_phone_key on users (phone);
