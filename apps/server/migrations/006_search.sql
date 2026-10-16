-- поиск по тексту сообщений: подстрока без учёта регистра, ускоренная триграммным индексом
create extension if not exists pg_trgm;
create index if not exists messages_body_trgm on messages using gin (body gin_trgm_ops);
