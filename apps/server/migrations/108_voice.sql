-- голосовые и кружки: вид вложения, длительность (с) и волна (63 байта: 100 значений по 5 бит, base64)
alter table attachments add column if not exists kind text;
alter table attachments add column if not exists duration int;
alter table attachments add column if not exists waveform text;
-- голосовое/кружок прослушан получателем (как media_unread в Telegram: у отправителя точка гаснет)
alter table messages add column if not exists listened boolean not null default false;
