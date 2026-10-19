-- чек-листы: сам список (задачи, флаги, отметки) и данные служебных строк «отметил(а) / добавил(а)»
alter table messages add column if not exists todo jsonb;
alter table messages add column if not exists service_data jsonb;
