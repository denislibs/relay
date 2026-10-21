-- Новый сеанс первые сутки ограничен (как в Telegram): не меняет пароль, почту восстановления и паскеи, не завершает
-- и не впускает другие сеансы. Снимается подтверждением «Это я» с другого устройства. Первый сеанс аккаунта
-- (регистрация, вход, когда других нет) — без ограничения: защищать нечего.
alter table sessions add column if not exists restricted_until timestamptz;
-- Подробности входа для «Новый вход» и списка сеансов: способ входа, место по IP, строка браузера
alter table sessions add column if not exists login_method text;
alter table sessions add column if not exists country text;
alter table sessions add column if not exists city text;
alter table sessions add column if not exists user_agent text;
-- коды входа: какое сообщение несёт код попытки — после входа или новой попытки код в нём скрывается
alter table login_attempts add column if not exists message_id bigint;
