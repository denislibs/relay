-- Паки по умолчанию выдаются один раз (user_sticker_init). На сервере, где ассеты стикеров появились позже первых
-- пользователей, отметка ставилась на пустом каталоге: ноль паков — навсегда. Сбросить отметку тем, у кого нет ни
-- одного пака, — при следующем открытии панели они получат паки по умолчанию (domain/stickers.ts: ensureDefaults).
delete from user_sticker_init i where not exists (select 1 from user_sticker_sets s where s.user_id = i.user_id);
