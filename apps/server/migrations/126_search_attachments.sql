-- запасной поиск находит вложения: имя файла, название и исполнитель трека — одной строкой через перевод строки
-- (в однострочном поле поиска его не набрать, поэтому совпадение не склеивает два поля); выражение повторено в domain/search.ts
create index if not exists messages_attachment_trgm on messages
  using gin ((coalesce(attachment->>'name', '') || E'\n' || coalesce(attachment->>'title', '') || E'\n' || coalesce(attachment->>'performer', '')) gin_trgm_ops)
  where attachment is not null;
