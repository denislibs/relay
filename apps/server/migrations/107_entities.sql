-- оформление текста (жирный, курсив, ссылки…): список сущностей { type, offset, length, url? }; null — простой текст
alter table messages add column if not exists entities jsonb;
alter table drafts add column if not exists entities jsonb;
