-- пределы загрузок (domain/uploadLimits.ts): идущие загрузки пользователя считаются по этому индексу на каждом POST /uploads
create index if not exists attachments_owner_pending on attachments (owner_id, created_at) where status = 'pending';
-- сборка мусора (domain/storageGc.ts) обходит готовые вложения курсором по (created_at, id)
create index if not exists attachments_ready_gc on attachments (created_at, id) where status = 'ready';
