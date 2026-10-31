-- Восстановление облачного пароля (аудит 2026-10-25, AUTH-2): попытки кода не сбрасываются новым кодом, лимиты на
-- пользователя в час — по отправкам кода и по неверным вводам (password.ts).
alter table password_recovery add column if not exists sends int not null default 1;
alter table password_recovery add column if not exists created_at timestamptz not null default now();
