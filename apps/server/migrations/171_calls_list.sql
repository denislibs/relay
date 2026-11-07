-- Список «Звонки» (domain/callsList.ts): звонки 1:1 — служебные сообщения call по личным чатам пользователя.
-- Частичный индекс: в каждом чате звонков мало, страница списка — по индексу, а не по всей истории чата.
create index if not exists messages_calls on messages (chat_id, id desc) where service_type = 'call';
-- «новые пропущенные» (бейдж у пункта меню) — новее этой отметки; null — ещё не открывал список
alter table user_settings add column if not exists calls_seen_at timestamptz;
