-- Журнал до шифрования хранил события целиком — с открытым текстом сообщений и черновиков (аудит 2026-10-25,
-- CRYPTO-3). Переписываем их в ссылки, как пишет stored() (journal.ts): тело подставляется при чтении (hydrate),
-- удалённое к тому времени сообщение придёт как messageDeleted.
update updates set payload = jsonb_build_object('type', 'newMessage', 'chatId', (payload->'message'->>'chatId')::bigint, 'id', (payload->'message'->>'id')::bigint, 'ref', 1)
 where type = 'newMessage' and not (payload ? 'ref') and payload ? 'message';
update updates set payload = jsonb_build_object('type', type, 'chatId', (payload->>'chatId')::bigint, 'id', (payload->>'id')::bigint, 'ref', 1)
 where type in ('messageEdited', 'messageMarkup', 'todoUpdated', 'linkPreview', 'attachmentUpdated') and not (payload ? 'ref') and payload ? 'id';
update updates set payload = jsonb_build_object('type', 'draft', 'chatId', (payload->>'chatId')::bigint, 'at', payload->>'at', 'ref', 1)
 where type = 'draft' and not (payload ? 'ref');
update updates set payload = jsonb_strip_nulls(jsonb_build_object('type', 'mention', 'chatId', (payload->'message'->>'chatId')::bigint, 'id', (payload->'message'->>'id')::bigint,
                                                                  'threadId', payload->'threadId', 'ref', 1))
 where type = 'mention' and not (payload ? 'ref') and payload ? 'message';
-- журнал чатов появился позже (144), но на всякий случай — те же правила
update chat_updates set payload = jsonb_build_object('type', 'newMessage', 'chatId', (payload->'message'->>'chatId')::bigint, 'id', (payload->'message'->>'id')::bigint, 'ref', 1)
 where type = 'newMessage' and not (payload ? 'ref') and payload ? 'message';
update chat_updates set payload = jsonb_build_object('type', type, 'chatId', (payload->>'chatId')::bigint, 'id', (payload->>'id')::bigint, 'ref', 1)
 where type in ('messageEdited', 'messageMarkup', 'todoUpdated', 'linkPreview', 'attachmentUpdated') and not (payload ? 'ref') and payload ? 'id';
-- срок хранения журнала пользователя (задача journal.trim): по времени записи
create index if not exists updates_created_at on updates (created_at);
