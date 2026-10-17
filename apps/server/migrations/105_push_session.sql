-- Подписка Web Push принадлежит сеансу: выход, завершение и автозавершение удаляют её вместе со строкой sessions.
-- Старые строки остаются без сеанса (null) — их удаляют следующий выход или «Завершить другие сеансы» владельца.
alter table push_subscriptions add column if not exists session_id bigint references sessions(id) on delete cascade;
create index if not exists push_subscriptions_session on push_subscriptions (session_id);
-- «Скрывать текст в уведомлениях» (prefs.screen.hideNotifyText) — настройка устройства, едет с подпиской
alter table push_subscriptions add column if not exists hide_text boolean not null default false;
