-- журнал действий админов (domain/adminLog.ts, «Недавние действия»): запись — в той же транзакции, что и само изменение.
-- data: только то, что и в исходном поле открыто (название, описание, настройки), и ссылки по id: тексты сообщений и
-- целиковые токены ссылок здесь не хранятся. Срок — 48 часов (задача adminLog.trim), чтение отсекает старше сразу.
-- Строка чата уходит — журнал каскадом; мягкое удаление чата стирает журнал само (deleteGroupTx).
create table if not exists admin_log (
  id       bigserial primary key,
  chat_id  bigint not null references chats(id) on delete cascade,
  actor_id bigint references users(id) on delete set null,
  action   text not null,
  data     jsonb not null default '{}',
  at       timestamptz not null default now()
);
create index if not exists admin_log_chat on admin_log (chat_id, id desc);
create index if not exists admin_log_at on admin_log (at);
