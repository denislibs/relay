-- поиск сообщения по одному id (индексация поиска: where id = any(...), перестройка: where id > ...) обходил
-- весь первичный ключ (chat_id, id) — 25 мс на запрос на полумиллионе строк
create index if not exists messages_id on messages (id);
-- (chat_id, id desc) дублирует первичный ключ (chat_id, id): B-дерево читается и назад — лишняя запись на каждую вставку
drop index if exists messages_chat_id_desc;
-- триграммы по body и вложению — для старого ILIKE-поиска; с шифрованием body пустой, а старые строки
-- перешифровывает crypto.encrypt; поиск — Meilisearch
drop index if exists messages_body_trgm;
drop index if exists messages_attachment_trgm;
