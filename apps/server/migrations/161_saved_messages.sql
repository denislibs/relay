-- «Избранное»: личный чат пользователя с самим собой (как Saved Messages в Telegram) — chats.kind = 'direct', единственный
-- участник. Создаётся при первом обращении; первичный ключ держит «один на пользователя» даже при гонке устройств.
-- hidden — чат удалили и с тех пор не открывали: пустого нет в списке, пока его снова не откроют или не напишут.
create table if not exists saved_chats (
  user_id bigint primary key references users on delete cascade,
  chat_id bigint not null unique references chats on delete cascade,
  hidden boolean not null default false
);
