-- тема чата (как «Изменить тему» в мобильном Telegram): id готовой темы из каталога (domain/themes.ts), null — без темы.
-- Видна всем участникам; клиент красит ею ленту и обои этого чата поверх своей темы.
alter table chats add column if not exists theme text;
