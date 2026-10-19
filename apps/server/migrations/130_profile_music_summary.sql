-- музыка профиля в самом профиле (PublicUser.music): сколько треков и последний добавленный — для плашки под аватаром.
-- Меняется вместе с profile_music в одной транзакции; зрители узнают об этом записью userUpdated в журнале
alter table users add column if not exists music jsonb;
update users u set music = s.music from (
  select p.user_id, jsonb_build_object(
    'count', count(*),
    'top', (array_agg(jsonb_build_object('id', p.attachment_id, 'title', p.title, 'duration', p.duration) order by p.added_at desc))[1]
  ) as music
  from profile_music p join attachments a on a.id = p.attachment_id and a.status = 'ready'
  group by p.user_id
) s where s.user_id = u.id;
