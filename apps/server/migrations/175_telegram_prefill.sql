-- «Войти через Telegram» для нового номера: имя, фамилия и фото из Telegram — подсказка в форму регистрации.
-- Живут только пока идёт вход: в telegram_logins — до опроса браузером, дальше — в заявке регистрации (login_pending).
alter table telegram_logins add column if not exists tg_first text;
alter table telegram_logins add column if not exists tg_last text;
alter table telegram_logins add column if not exists tg_photo text;   -- file_id фото профиля (сам файл — только через сервер: в адресе токен бота)
alter table login_pending add column if not exists prefill jsonb;     -- { first, last, photo } для формы регистрации
