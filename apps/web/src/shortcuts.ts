// Каталог сочетаний клавиш — единственный источник для страницы «Сочетания клавиш».
// Сочетания записаны в нотации hotkeys.js ('mod' — ⌘ на Apple, Ctrl на остальных); строка показывает
// альтернативы через «/» и диапазоны («1…9») — подписи собирает comboKeys.
// Сюда попадает только то, что действительно работает: обработчики живут в composer.js, Sidebar, Chat и плеерах.

export type Shortcut = {
  id: string;
  title: string;
  hint?: string;
  /** Варианты сочетания (показываются через «/»). */
  combos: string[];
  /** Хвост-диапазон вместо последней клавиши: 'ctrl+shift+1' показывается как «Ctrl ⇧ 1…9». */
  range?: string;
};
export type ShortcutSection = { id: string; title: string; footer?: string; items: Shortcut[] };

export const SEARCH_IN_CHAT = 'mod+f';
export const GLOBAL_SEARCH = 'mod+shift+f';
export const NEXT_CHAT = 'alt+arrowdown';
export const PREV_CHAT = 'alt+arrowup';

/** Отправка зависит от настройки: Enter или ⌘/Ctrl+Enter. */
export function sendCombos(sendKey: 'enter' | 'ctrlEnter'): { send: string; newline: string } {
  return sendKey === 'ctrlEnter' ? { send: 'mod+enter', newline: 'enter' } : { send: 'enter', newline: 'shift+enter' };
}

export function shortcutSections(sendKey: 'enter' | 'ctrlEnter'): ShortcutSection[] {
  const s = sendCombos(sendKey);
  return [
    {
      id: 'format', title: 'Оформление текста', footer: 'Выделите текст в поле ввода, чтобы применить оформление.',
      items: [
        { id: 'bold', title: 'Жирный', combos: ['mod+b'] },
        { id: 'italic', title: 'Курсив', combos: ['mod+i'] },
        { id: 'underline', title: 'Подчёркнутый', combos: ['mod+u'] },
        { id: 'strike', title: 'Зачёркнутый', combos: ['mod+shift+x'] },
        { id: 'mono', title: 'Моноширинный', combos: ['mod+shift+m'] },
        { id: 'spoiler', title: 'Скрытый текст', combos: ['mod+shift+p'] },
        { id: 'link', title: 'Ссылка', combos: ['mod+k'] },
        { id: 'date', title: 'Дата', combos: ['mod+d'] },
      ],
    },
    {
      id: 'messages', title: 'Сообщения',
      items: [
        { id: 'send', title: 'Отправить', combos: [s.send] },
        { id: 'newline', title: 'Новая строка', combos: [s.newline] },
        { id: 'editLast', title: 'Изменить последнее', hint: 'Когда поле ввода пустое', combos: ['arrowup'] },
        { id: 'replyPrev', title: 'Ответить на предыдущее', hint: 'Когда поле ввода пустое', combos: ['mod+arrowup'] },
        { id: 'replyNext', title: 'Ответить на следующее', hint: 'Когда поле ввода пустое', combos: ['mod+arrowdown'] },
        { id: 'cancel', title: 'Отменить ответ или правку', combos: ['escape'] },
      ],
    },
    {
      id: 'chats', title: 'Чаты',
      items: [
        { id: 'prevChat', title: 'Предыдущий чат', combos: [PREV_CHAT] },
        { id: 'nextChat', title: 'Следующий чат', combos: [NEXT_CHAT] },
        { id: 'folder', title: 'Папка по номеру', combos: ['ctrl+shift+1'], range: '1…9' },
        { id: 'findInChat', title: 'Поиск по чату', combos: [SEARCH_IN_CHAT] },
        { id: 'search', title: 'Поиск по всем чатам', combos: [GLOBAL_SEARCH] },
        { id: 'close', title: 'Закрыть окно, меню или чат', combos: ['escape'] },
      ],
    },
    {
      id: 'media', title: 'Просмотр медиа',
      items: [
        { id: 'mediaNext', title: 'Следующее', combos: ['arrowright'] },
        { id: 'mediaPrev', title: 'Предыдущее', combos: ['arrowleft'] },
        { id: 'mediaClose', title: 'Закрыть', combos: ['escape'] },
      ],
    },
    {
      id: 'video', title: 'Видео',
      items: [
        { id: 'play', title: 'Воспроизвести или пауза', combos: ['space', 'k'] },
        { id: 'seek', title: 'Перемотать на 5 секунд', combos: ['arrowleft', 'arrowright'] },
        { id: 'volume', title: 'Громкость', combos: ['arrowup', 'arrowdown'] },
        { id: 'mute', title: 'Выключить звук', combos: ['m'] },
        { id: 'full', title: 'Во весь экран', combos: ['f'] },
      ],
    },
    {
      id: 'voice', title: 'Запись голосового',
      items: [
        { id: 'voicePause', title: 'Пауза', combos: ['space'] },
        { id: 'voiceDelete', title: 'Удалить запись', combos: ['escape'] },
      ],
    },
  ];
}
