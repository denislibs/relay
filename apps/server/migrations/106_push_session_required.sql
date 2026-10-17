-- Web Push только живым сеансам: подписки без сеанса (до 105_push_session) удаляются, session_id обязателен.
-- Клиент отправляет подписку при каждом старте — она вернётся, привязанная к текущему сеансу.
-- Каскад (on delete cascade из 105) остаётся: выход, завершение и автозавершение удаляют подписку вместе с сеансом.
delete from push_subscriptions where session_id is null;
alter table push_subscriptions alter column session_id set not null;
