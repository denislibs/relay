-- Лимиты кодов входа: попытки не удаляются при использовании (dead_at), считаются по нормализованному логину и IP.
alter table login_attempts add column if not exists dead_at timestamptz;
alter table login_attempts add column if not exists login text not null default '';
alter table login_attempts add column if not exists ip text;
create index if not exists login_attempts_login on login_attempts (login, created_at desc);
create index if not exists login_attempts_ip on login_attempts (ip, created_at desc) where ip is not null;
