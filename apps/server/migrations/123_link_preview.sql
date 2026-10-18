-- Превью ссылок, как в Telegram: сервер сам загружает страницу (OG-метаданные) и картинку в наше хранилище.
-- link_previews — кэш по адресу (data null — у страницы нет превью); messages.link — превью у сообщения
-- ({url, pending:true}, пока задача не загрузила страницу).
create table if not exists link_previews (
  url        text primary key,
  data       jsonb,
  photo_id   uuid,
  fetched_at timestamptz not null default now()
);
create index if not exists link_previews_photo on link_previews (photo_id) where photo_id is not null;
alter table messages add column if not exists link jsonb;
