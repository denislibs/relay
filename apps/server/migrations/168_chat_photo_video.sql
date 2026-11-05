-- видео-аватарка группы и канала (GIF или видео, зациклено, без звука), как у фото профиля; big/small — её кадр
alter table chat_photos add column if not exists video uuid;
create index if not exists chat_photos_video on chat_photos (video) where video is not null;
