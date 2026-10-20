-- кнопки под сообщением (inline-клавиатура): ряды [{text, kind, data | url}]; пока их шлёт только служебный «Relay»
alter table messages add column if not exists buttons jsonb;
