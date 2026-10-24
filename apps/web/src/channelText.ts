// Каналы на клиенте: тексты и правила без DOM (юнит-тесты — channelText.test.ts).

/** Русское склонение по числу: 1 комментарий, 2 комментария, 5 комментариев. */
export const plural = (n: number, one: string, few: string, many: string): string =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;

/** Подпись кнопки под постом: «Оставить комментарий», пока их нет, дальше — «N комментариев». */
export function commentsLabel(count: number): string {
  return count > 0 ? `${count} ${plural(count, 'комментарий', 'комментария', 'комментариев')}` : 'Оставить комментарий';
}

/** Шапка треда: «N комментариев»; пока пусто — «Комментарии». */
export const threadTitle = (count: number): string => (count > 0 ? commentsLabel(count) : 'Комментарии');

/**
 * Кнопка «N комментариев» под постом (как в Telegram): участник группы обсуждения и подписчик канала открывают тред
 * (подписчик — гостем, не вступая; если группа пускает писать только участников, тред покажет «Вступить в группу»);
 * копии поста ещё нет (replies не пришли) — ждать; не подписан на канал — подсказка подписаться.
 */
export function commentsAction(o: { member: boolean; subscriber: boolean; replies: boolean }): 'thread' | 'wait' | 'hint' {
  if (!o.member && !o.subscriber) return 'hint';
  return o.replies ? 'thread' : 'wait';
}

/** Вместо поля ввода в треде гостя: пишут только участники — «Вступить в группу», вступление по заявке — «Подать заявку». */
export function guestJoinLabel(g: { joinToSend: boolean; joinApproval: boolean } | null | undefined): string | null {
  if (!g) return null;
  return g.joinApproval ? 'Подать заявку' : g.joinToSend ? 'Вступить в группу' : null;
}

/** «N подписчиков» — в шапке канала, в «Информации», в строке списка. */
export const subscribersText = (n: number): string => `${n} ${plural(n, 'подписчик', 'подписчика', 'подписчиков')}`;

/** Просмотры компактно, как в Telegram: 999, 1,2K, 15K, 1,5M (дробная часть — одна цифра и только до 10). */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.trunc(n || 0)));
  const [v, s] = n < 1e6 ? [n / 1e3, 'K'] : [n / 1e6, 'M'];
  const shown = v < 10 ? Math.floor(v * 10) / 10 : Math.floor(v);
  return String(shown).replace('.', ',') + s;
}

/** Строка уведомления (запрос notifications движка): то, что нужно правилу. */
export interface NotifyItem { chatId: number; post?: boolean; mention?: boolean }
/** Чат из списка: вид, связанный чат, могу ли я публиковать (канал) и состою ли в нём (канал в списке бывает и без подписки). */
export interface NotifyChat { id: number; kind?: unknown; linkedChatId?: number | null; canPost?: boolean; member?: boolean }

/**
 * Не уведомлять о посте, который публикую я сам (или могу публиковать): пост канала, где у меня право post, и его
 * копия в группе обсуждения такого канала. Автор поста на сервере скрыт (senderId 0), а копия приходит в группу
 * отдельным сообщением со своим clientId — «моё» по ним не определить. Самое простое верное правило: тот, кто
 * может публиковать в канале, о постах этого канала (и их копиях) не уведомляется — он их и пишет. Упоминание
 * важнее: оно уведомляет всегда.
 */
export function isOwnChannelPost(n: NotifyItem, chatOf: (id: number) => NotifyChat | undefined): boolean {
  if (!n.post || n.mention) return false;
  const c = chatOf(n.chatId);
  if (!c) return false;
  if (c.kind === 'channel') return !!c.canPost;
  const ch = c.linkedChatId != null ? chatOf(c.linkedChatId) : undefined;   // копия поста в группе обсуждения
  return ch?.kind === 'channel' && !!ch.canPost;
}

/**
 * Копия поста в группе обсуждения: канал, к которому она относится (иначе undefined). Подписчик канала, состоящий и
 * в группе, получает пост дважды — сам пост и его копию; уведомлять стоит один раз, о посте. Копия и при открытом
 * канале — «на экране»: пост уже виден в его ленте. Упоминание — не копия: оно уведомляет всегда.
 */
export function postCopyChannel(n: NotifyItem, chatOf: (id: number) => NotifyChat | undefined): NotifyChat | undefined {
  if (!n.post || n.mention) return undefined;
  const c = chatOf(n.chatId);
  if (c?.kind !== 'group' || c.linkedChatId == null) return undefined;
  const ch = chatOf(c.linkedChatId);
  return ch?.kind === 'channel' ? ch : undefined;
}

/** «Кто прочитал»: только своё сообщение в группе до 100 участников, не комментарий в треде и не копия поста. */
export function canAskReadBy(m: Record<string, unknown>,
  chat: { kind?: unknown; members?: number } | null | undefined, meId: number): boolean {
  return !!chat && chat.kind === 'group' && (chat.members ?? Infinity) <= 100 && m.senderId === meId && m.id != null && !m.deleted && !m.service
    && m.threadId == null && m.origin == null && !m.post;
}
