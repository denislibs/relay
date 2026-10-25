-- содержимое особых сообщений — контакт, геопозиция, кубики — одним полем (шифром в content, ключ 'x')
alter table messages add column if not exists data jsonb;
