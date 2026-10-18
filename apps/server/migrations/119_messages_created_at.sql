-- «Перейти к дате»: первое сообщение чата не раньше момента — по индексу, а не перебором ленты
create index if not exists messages_chat_created on messages (chat_id, created_at, id);
