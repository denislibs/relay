-- Настройки пользователя, общие для всех его устройств. Строки нет — действуют умолчания (domain/settings.ts).
-- notify: умолчания уведомлений по виду чата; sessions_ttl_days — через сколько неактивности сеанс закрывается (B9).
create table if not exists user_settings (
  user_id          bigint primary key references users on delete cascade,
  notify           jsonb not null default '{"direct":{"muted":false,"preview":true},"group":{"muted":false,"preview":true}}',
  sessions_ttl_days int not null default 180,
  updated_at       timestamptz not null default now()
);
