-- Ссылки профиля: [{service, handle}] в порядке владельца. Адрес собирается по шаблону сервиса (protocol/links.ts),
-- поэтому храним только имя. Проверка формы — в домене; здесь — что это массив и не длиннее предела.
alter table users add column if not exists links jsonb not null default '[]'
  check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 10);
