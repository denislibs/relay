/**
 * Какие строки ленты играют анимацию появления. Как в Telegram — только новые сообщения живой ленты: пришли или
 * отправлены, пока чат открыт. История, пришедшая сдвигом окна (вверх или вниз), догрузкой сверху или переходом
 * к сообщению, встаёт сразу: строка с анимацией начинается прозрачной, и при быстрой прокрутке на месте только что
 * пришедших альбомов была видна пустота (обои вместо миниатюр).
 */
export type FeedSeen = { list: readonly { key: string }[]; keys: Set<string>; live: boolean };

/** Прошлое окно → новое: ключи пришедших сообщений и снимок для следующего сравнения. */
export function arrivals(prev: FeedSeen | null, list: readonly { key: string }[], live: boolean): { fresh: string[]; seen: FeedSeen } {
  const seen: FeedSeen = { list, keys: new Set(list.map((m) => m.key)), live };
  const fresh: string[] = [];
  // окно было и осталось у живого края: новые — ниже первого уже показанного сообщения; всё, что встало выше
  // него, — история. Окно сменилось целиком (нет общих строк) — тоже история
  if (prev && prev.live && live) {
    const first = list.findIndex((m) => prev.keys.has(m.key));
    if (first >= 0) for (let i = first + 1; i < list.length; i++) if (!prev.keys.has(list[i].key)) fresh.push(list[i].key);
  }
  return { fresh, seen };
}
