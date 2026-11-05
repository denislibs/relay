-- «Без звука» и напоминания: метаданные сообщения (не содержимое), по ним решается, уведомлять ли.
-- silent — получатели не получают push и звук; reminder — отложенное себе в «Избранное»: автор получает уведомление.
alter table messages add column if not exists silent boolean not null default false;
alter table messages add column if not exists reminder boolean not null default false;

-- Отложенные сообщения: видны только автору, до публикации в messages ничего нет (поиск, счётчики и медиа их не знают).
-- Текст, оформление, снимок вложения и стикера — только в content, шифром ключа чата (domain/scheduled.ts). Открытые
-- столбцы — метаданные, как у messages. client_id станет client_id сообщения: повтор публикации дубля не создаст.
-- attachment_id — чтобы сборка мусора (storageGc.ts) не удалила файл, пока сообщение ждёт.
-- rev растёт при каждой правке: старый ответ не перетрёт новый на клиенте.
-- failed — код отказа: опубликовать не вышло, но чат ещё доступен (заблокировали, отобрали право) — можно исправить или удалить.
create table if not exists scheduled_messages (
  user_id bigint not null references users on delete cascade,
  client_id uuid not null,
  chat_id bigint not null references chats on delete cascade,
  kind text not null,
  send_at timestamptz not null,
  silent boolean not null default false,
  reply_to_id bigint,
  group_id uuid,
  attachment_id uuid,
  content bytea not null,
  rev integer not null default 1,
  failed text,
  created_at timestamptz not null default now(),
  primary key (user_id, client_id)
);
create index if not exists scheduled_by_chat on scheduled_messages (user_id, chat_id, send_at);
create index if not exists scheduled_of_chat on scheduled_messages (chat_id);
create index if not exists scheduled_due on scheduled_messages (send_at) where failed is null;
create index if not exists scheduled_attachment on scheduled_messages (attachment_id) where attachment_id is not null;
