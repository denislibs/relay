-- музыка в профиле («Добавить в профиль», как в Telegram): треки из чатов, видны всем, кроме заблокированных владельцем
create table if not exists profile_music (
  user_id       bigint not null references users(id) on delete cascade,
  attachment_id uuid   not null references attachments(id) on delete cascade,
  title         text   not null,
  duration      integer,
  added_at      timestamptz not null default now(),
  primary key (user_id, attachment_id)
);
create index if not exists profile_music_attachment on profile_music (attachment_id);
