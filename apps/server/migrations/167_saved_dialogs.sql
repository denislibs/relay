-- Подчаты «Избранного» (как saved_peer_id в Telegram). saved_peer — к какому подчату относится сообщение: 'me' — «Мои заметки»
-- (своё, копия без заголовка), 'u<id>' — личный чат с этим человеком, 'c<id>' — группа или канал, 'hidden' — «Автор скрыт»
-- (известно только имя: источник — чужая переписка или чата больше нет). Только у сообщений чата «Избранное», у служебных и
-- стёртых — null. Выводится из fwd_from (открыт с миграции 122) и состава личного чата: нового открытого содержимого нет.
alter table messages add column if not exists saved_peer text;
update messages m set saved_peer = case
    when m.fwd_from is null or (m.fwd_from->>'chatId')::bigint = m.chat_id then 'me'
    else coalesce((
      select case
               when src.kind = 'direct' then (select 'u' || o.user_id from chat_members me join chat_members o on o.chat_id = me.chat_id and o.user_id <> me.user_id
                                               where me.chat_id = src.id and me.user_id = s.user_id limit 1)
               when src.deleted_at is null then 'c' || src.id
             end
        from chats src where src.id = (m.fwd_from->>'chatId')::bigint), 'hidden')
  end
  from saved_chats s
 where s.chat_id = m.chat_id and m.saved_peer is null and m.service_type is null and not m.deleted;
-- список подчатов, лента и медиа подчата: частичный индекс — других чатов он не касается
create index if not exists messages_saved_peer on messages (chat_id, saved_peer, id desc) where saved_peer is not null;

-- Закреплённые подчаты: только у владельца, порядок — время закрепления (позже — выше).
create table if not exists saved_dialog_pins (
  user_id bigint not null references users on delete cascade,
  peer text not null,
  pinned_at timestamptz not null default now(),
  primary key (user_id, peer)
);
