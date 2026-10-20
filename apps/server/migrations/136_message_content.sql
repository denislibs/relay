-- содержимое сообщения и черновика шифром ключа чата (domain/messageContent.ts): текст, разметка, чек-лист, статья,
-- превью ссылки, текстовые поля вложения. Открытые столбцы у зашифрованных строк пустые; старые строки догоняет
-- задача crypto.encrypt.
alter table messages add column if not exists content bytea;
-- «в сообщении есть ссылка» — открытый признак для вкладки «Ссылки» (текст в шифре, регуляркой по нему не найти)
alter table messages add column if not exists has_link boolean not null default false;
alter table drafts add column if not exists content bytea;
alter table drafts add column if not exists entities jsonb;
