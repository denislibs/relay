-- push.message листает подписки чата по курсору (user_id, endpoint): индекс под порядок и сравнение кортежа
create index if not exists push_subscriptions_user_endpoint on push_subscriptions (user_id, endpoint);
