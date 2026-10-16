-- подписки Web Push: одна на браузер; muted — чаты, выключенные на этом устройстве
create table if not exists push_subscriptions (
  endpoint text primary key,
  user_id bigint not null references users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  muted bigint[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on push_subscriptions (user_id);
