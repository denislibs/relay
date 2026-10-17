import { plural } from '@relay/ui';

/** «Очистить локальные данные»: тексты диалога (общие для «Данных и памяти» и раздела «Для разработчиков»).
 *  n — неотправленные сообщения и правки; run(keepOutbox). */
export function clearLocalDialog(n: number, run: (keepOutbox: boolean) => void) {
  return n > 0
    ? {
        title: 'Очистить локальные данные?',
        text: `${n} ${plural(n, 'сообщение ещё не отправлено', 'сообщения ещё не отправлены', 'сообщений ещё не отправлено')}. Можно оставить их и отправить позже или удалить вместе с остальным. Черновики удалятся в любом случае. Чаты загрузятся с сервера заново.`,
        confirm: 'Удалить всё',
        run: () => run(false),
        extra: { label: 'Оставить неотправленные', onClick: () => run(true) } as { label: string; onClick: () => void } | undefined,
      }
    : {
        title: 'Очистить локальные данные?',
        text: 'Чаты, сообщения и черновики на устройстве удалятся, чаты загрузятся с сервера заново. Неотправленного нет.',
        confirm: 'Очистить',
        run: () => run(true),
        extra: undefined as { label: string; onClick: () => void } | undefined,
      };
}
