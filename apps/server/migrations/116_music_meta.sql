-- музыка: название и исполнитель из тегов файла; группа сообщений (несколько файлов, отправленных вместе — один пузырь)
alter table attachments add column if not exists title text;
alter table attachments add column if not exists performer text;
alter table messages add column if not exists group_id uuid;
