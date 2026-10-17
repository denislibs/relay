-- Правила конфиденциальности (domain/privacy.ts). Строки нет — умолчание: номер — контактам, остальное — всем.
-- allow/deny — исключения (id пользователей); deny главнее allow, allow главнее mode.
create table if not exists privacy_rules (
  user_id    bigint not null references users on delete cascade,
  key        text not null check (key in ('phone', 'phoneDiscovery', 'lastSeen', 'bio', 'birthday')),
  mode       text not null check (mode in ('everyone', 'contacts', 'nobody')),
  allow      bigint[] not null default '{}',
  deny       bigint[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
