-- счётчик доставок одноразовых кодов внешним каналом за сутки (domain/codeDelivery.ts): дневной потолок Telegram-бота.
-- Строка на канал и день (UTC); сами коды и адресаты здесь не хранятся. Старше недели удаляет сама доставка.
create table if not exists code_deliveries (
  channel text not null,
  day     date not null,
  n       int not null default 0,
  primary key (channel, day)
);
