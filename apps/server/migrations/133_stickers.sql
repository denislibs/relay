-- Стикерпаки из apps/server/assets/stickers (импорт: src/stickers/import.ts). Файлы — на диске, здесь метаданные.
create table if not exists sticker_sets (
  id bigserial primary key,
  short_name text not null unique,
  title text not null,
  kind text not null check (kind in ('sticker', 'emoji')),
  position int not null,                 -- порядок в _index.json: «рекомендуемые» и наборы по умолчанию
  count int not null,
  cover_file text,                       -- обложка пака (cover.tgs) или первый стикер
  cover_hash text,
  hash text not null                     -- хэш meta.json: изменился — набор переимпортирован, клиент перечитает
);
create index if not exists sticker_sets_title_trgm on sticker_sets using gin (lower(title) gin_trgm_ops);

create table if not exists stickers (
  id bigserial primary key,
  set_id bigint not null references sticker_sets(id) on delete cascade,
  idx int not null,
  file text not null,
  file_hash text not null,               -- первые 8 hex sha256: часть адреса /stk/<пак>/<хэш>/<файл>
  format text not null check (format in ('tgs', 'webp', 'json')),
  emoji text not null,
  w int not null,
  h int not null,
  outline text,                          -- сжатый векторный контур (силуэт до загрузки)
  unique (set_id, idx)
);
create index if not exists stickers_emoji on stickers (emoji);

-- наборы пользователя: установленные паки, недавние (до 20), избранные (до 5)
create table if not exists user_sticker_sets (
  user_id bigint not null references users(id) on delete cascade,
  set_id bigint not null references sticker_sets(id) on delete cascade,
  position int not null,
  added_at timestamptz not null default now(),
  primary key (user_id, set_id)
);
create table if not exists recent_stickers (
  user_id bigint not null references users(id) on delete cascade,
  sticker_id bigint not null references stickers(id) on delete cascade,
  used_at timestamptz not null default now(),
  primary key (user_id, sticker_id)
);
create table if not exists faved_stickers (
  user_id bigint not null references users(id) on delete cascade,
  sticker_id bigint not null references stickers(id) on delete cascade,
  faved_at timestamptz not null default now(),
  primary key (user_id, sticker_id)
);
-- наборы по умолчанию ставятся один раз: удалил все паки — пусто, а не «вернулись сами»
create table if not exists user_sticker_init (user_id bigint primary key references users(id) on delete cascade);

-- сообщение-стикер несёт снимок стикера: лента рисуется без запросов, удалённый пак сообщению не мешает
alter table messages add column if not exists sticker jsonb;
