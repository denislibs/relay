-- Очередь задач (transactional outbox): задача пишется в транзакции изменения, воркер забирает её после коммита.
create table if not exists jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null default '{}',
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 8,
  locked_until timestamptz,          -- аренда воркера; истекла — задачу может забрать другой
  last_error text,
  dedupe_key text,                   -- периодические задачи: не больше одной на ключ
  created_at timestamptz not null default now()
);
create index if not exists jobs_due on jobs (run_at, id);
create unique index if not exists jobs_dedupe on jobs (dedupe_key) where dedupe_key is not null;

-- Задачи, исчерпавшие попытки или с постоянной ошибкой. Секрет из payload сюда не копируется.
create table if not exists jobs_dead (
  id bigint primary key,
  kind text not null,
  payload jsonb not null,
  attempts int not null,
  last_error text,
  created_at timestamptz not null,
  failed_at timestamptz not null default now()
);

-- Кто онлайн, для всех процессов: строка на (процесс, пользователь). Протухшие строки упавших процессов
-- отсекаются по seen_at, закрытые — по left_at с паузой RELAY_PRESENCE_GRACE_MS.
create table if not exists live_conns (
  process_id uuid not null,
  user_id bigint not null references users(id) on delete cascade,
  conns int not null,
  left_at timestamptz,
  seen_at timestamptz not null default now(),
  primary key (process_id, user_id)
);
create index if not exists live_conns_user on live_conns (user_id);

-- Dev-почта (DEV_LOGIN=1): письма, которые в проде ушли бы через почтовый шлюз. Читает /dev/codes.
create table if not exists dev_mail (
  id bigserial primary key,
  at timestamptz not null default now(),
  to_addr text not null,
  kind text not null,
  code text not null
);
