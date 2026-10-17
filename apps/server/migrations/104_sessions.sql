-- Активные сеансы (B9): номер сеанса для списка и завершения, устройство и IP входа, последняя активность.
-- token_hash остаётся ключом; существующие строки получают id автоматически.
alter table sessions add column if not exists id bigint generated always as identity;
create unique index if not exists sessions_id_key on sessions (id);
alter table sessions add column if not exists device text;
alter table sessions add column if not exists ip text;
alter table sessions add column if not exists last_active_at timestamptz not null default now();
create index if not exists sessions_user_idx on sessions (user_id, last_active_at desc);
