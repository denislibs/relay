-- История фото профиля (как в Telegram: все поставленные фото, листаются в профиле и просмотре).
-- users.photo — текущее (главное), для быстрых списков; здесь — всё, новые сверху.
create table if not exists user_photos (
  id          bigserial primary key,
  user_id     bigint not null references users on delete cascade,
  big         uuid not null,
  small       uuid not null,
  thumb       text not null,
  video       uuid,             -- видео-аватарка (зациклено, без звука); big/small — её кадр
  created_at  timestamptz not null default now()
);
create index if not exists user_photos_user on user_photos (user_id, id desc);
create index if not exists user_photos_big on user_photos (big);
create index if not exists user_photos_small on user_photos (small);
create index if not exists user_photos_video on user_photos (video) where video is not null;
-- уже поставленные фото — первая запись истории
insert into user_photos (user_id, big, small, thumb, created_at)
  select id, (photo->>'id')::uuid, (photo->>'small')::uuid, photo->>'thumb', to_timestamp((photo->>'at')::bigint / 1000.0)
    from users u where photo is not null and not exists (select 1 from user_photos p where p.user_id = u.id);
