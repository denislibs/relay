-- поколение базы: меняется при пересоздании данных (seed --reset); клиент с другим поколением сбрасывает кэш
create table if not exists server_meta (k text primary key, v text not null);
insert into server_meta (k, v) values ('epoch', md5(random()::text || clock_timestamp()::text)) on conflict (k) do nothing;
