// Дата в тексте сообщения (сущность date) — как в Telegram Web A:
//  формат 'r' — относительно (Intl.RelativeTimeFormat, numeric:'auto': «завтра», «через 3 часа»); меньше минуты — «сейчас»;
//  иначе по буквам: w — день недели, d / D — дата коротко / полностью, t / T — время коротко / с секундами;
//  пустой формат — показывается сам текст сообщения.
var LOCALE = 'ru-RU';

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

/** Текст даты по формату. date — unix-секунды, now — Date (для тестов). */
export function formatDateEntity(date, format, now) {
  var d = new Date(date * 1000), n = now || new Date();
  if (format === 'r') {
    var rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
    var diff = (d.getTime() - n.getTime()) / 1000, abs = Math.abs(diff);
    if (abs < 60) return 'сейчас';
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round((startOfDay(d) - startOfDay(n)) / 86400000), 'day');
  }
  var o = {};
  if (format.indexOf('w') >= 0) o.weekday = 'long';
  if (format.indexOf('D') >= 0) { o.day = 'numeric'; o.month = 'long'; o.year = 'numeric'; }
  else if (format.indexOf('d') >= 0) { o.day = 'numeric'; o.month = 'short'; o.year = 'numeric'; }
  if (format.indexOf('T') >= 0) { o.hour = '2-digit'; o.minute = '2-digit'; o.second = '2-digit'; }
  else if (format.indexOf('t') >= 0) { o.hour = '2-digit'; o.minute = '2-digit'; }
  if (!Object.keys(o).length) return null;
  return new Intl.DateTimeFormat(LOCALE, o).format(d);
}

/** Полная дата для подсказки и «Копировать дату»: день недели, дата, время с секундами. */
export function fullDate(date) {
  return new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(date * 1000));
}

/** Текст по умолчанию для вставки из окна: дата полностью и время коротко (как в Telegram). */
export function defaultDateLabel(date) {
  return formatDateEntity(date, 'Dt');
}

/** Через сколько мс перерисовать относительную дату: внутри минуты — каждую секунду, часа — минуту, суток — час. */
export function relativeRefreshMs(date, now) {
  var abs = Math.abs(date * 1000 - (now || Date.now()));
  return abs < 60000 ? 1000 : abs < 3600000 ? 60000 : abs < 86400000 ? 3600000 : 0;
}

/** Собрать формат из выбора в окне: relative | { date: 'none'|'short'|'long', time: …, weekday }. */
export function buildDateFormat(o) {
  if (o.relative) return 'r';
  return (o.weekday ? 'w' : '') + (o.date === 'short' ? 'd' : o.date === 'long' ? 'D' : '') + (o.time === 'short' ? 't' : o.time === 'long' ? 'T' : '');
}
export function parseDateFormat(f) {
  f = f || '';
  return { relative: f === 'r', weekday: f.indexOf('w') >= 0, date: f.indexOf('D') >= 0 ? 'long' : f.indexOf('d') >= 0 ? 'short' : 'none', time: f.indexOf('T') >= 0 ? 'long' : f.indexOf('t') >= 0 ? 'short' : 'none' };
}
