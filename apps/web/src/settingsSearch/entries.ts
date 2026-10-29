// Индекс поиска по настройкам. Ручной: у страниц настроек нет реестра (это JSX), а пунктов немного.
// Раздел (`section`) — сама страница из PAGES; остальные пункты помечены на странице атрибутом data-setting
// (значение — `anchor`, если задан, иначе id). Целостность проверяет entries.test.ts.
import { shortcutSections } from '../shortcuts';
import type { Entry } from './match';

export type { Entry };
type E = Entry & { anchor?: string };

const dev = (c: { dev: boolean }) => c.dev;
const hasPw = (c: { hasPassword: boolean | null }) => c.hasPassword === true;
const noPw = (c: { hasPassword: boolean | null }) => c.hasPassword === false;

const PROFILE = 'settings/profile', GENERAL = 'settings/general', WP = 'settings/general/wallpaper';
const NOTIFY = 'settings/notifications', PRIVACY = 'settings/privacy', PASSWORD = 'settings/privacy/password';
const DATA = 'settings/data', PERF = 'settings/performance', FOLDERS = 'settings/folders', SESSIONS = 'settings/sessions';

const RULES: [key: string, title: string, keywords: string[]][] = [
  ['phone', 'Номер телефона', ['кто видит номер', 'телефон']],
  ['lastSeen', 'Последний визит и «в сети»', ['онлайн', 'был в сети', 'время захода', 'статус']],
  ['bio', 'О себе', ['кто видит описание']],
  ['birthday', 'День рождения', ['кто видит дату рождения']],
];

const AUTOLOAD: [kind: string, title: string][] = [['photo', 'Фото'], ['video', 'Видео'], ['file', 'Файлы']];
const AUTOLOAD_ROWS: [field: string, title: string][] = [['contacts', 'Контакты'], ['private', 'Личные чаты'], ['groups', 'Группы']];

export const ENTRIES: E[] = [
  // ---------- Аккаунт ----------
  { id: 'profile', path: PROFILE, title: 'Аккаунт', kind: 'section', icon: 'account', tile: 'blue', keywords: ['профиль', 'изменить профиль'] },
  { id: 'profile.firstName', path: PROFILE, title: 'Имя', kind: 'row', keywords: ['изменить имя'] },
  { id: 'profile.lastName', path: PROFILE, title: 'Фамилия', kind: 'row' },
  { id: 'profile.bio', path: PROFILE, title: 'О себе', kind: 'row', keywords: ['био', 'описание'] },
  { id: 'profile.username', path: PROFILE, title: 'Имя пользователя', kind: 'row', keywords: ['username', 'юзернейм', 'ник', 'логин', 'ссылка на профиль'] },
  { id: 'profile.birthday', path: PROFILE, title: 'День рождения', kind: 'row', keywords: ['дата рождения'] },
  { id: 'profile.photo', path: PROFILE, title: 'Фото профиля', kind: 'row', keywords: ['аватар', 'аватарка', 'сменить фото', 'поставить фото'] },
  { id: 'profile.links', path: 'settings/profile/links', title: 'Ссылки', kind: 'section', keywords: ['соцсети', 'сайт'] },
  { id: 'profile.links.add', path: 'settings/profile/links', title: 'Добавить ссылку', kind: 'row' },

  // ---------- Общие ----------
  { id: 'general', path: GENERAL, title: 'Общие настройки', kind: 'section', icon: 'general', tile: 'orange', keywords: ['основные', 'оформление', 'внешний вид'] },
  { id: 'general.textSize', path: GENERAL, title: 'Размер текста сообщений', kind: 'row', keywords: ['шрифт', 'крупный текст', 'масштаб'] },
  { id: 'general.theme', path: GENERAL, title: 'Тема', kind: 'subsection', keywords: ['оформление', 'внешний вид'] },
  { id: 'general.theme.system', path: GENERAL, parent: 'general.theme', title: 'Как в системе', kind: 'option', keywords: ['автоматически', 'системная тема'] },
  { id: 'general.theme.light', path: GENERAL, parent: 'general.theme', title: 'Светлая', kind: 'option', keywords: ['светлая тема', 'дневной режим'] },
  { id: 'general.theme.dark', path: GENERAL, parent: 'general.theme', title: 'Тёмная', kind: 'option', keywords: ['тёмная тема', 'ночной режим', 'ночная тема', 'dark'] },
  { id: 'general.accent', path: GENERAL, title: 'Цвет акцента', kind: 'subsection', keywords: ['цветовая схема', 'цвет интерфейса'] },
  { id: 'general.timeFormat', path: GENERAL, title: 'Формат времени', kind: 'subsection', keywords: ['часы'] },
  { id: 'general.timeFormat.12h', path: GENERAL, parent: 'general.timeFormat', title: '12 часов', kind: 'option', keywords: ['am pm'] },
  { id: 'general.timeFormat.24h', path: GENERAL, parent: 'general.timeFormat', title: '24 часа', kind: 'option' },
  { id: 'general.sendKey', path: GENERAL, title: 'Клавиатура', kind: 'subsection', keywords: ['отправка сообщений', 'enter'] },
  { id: 'general.sendKey.enter', path: GENERAL, parent: 'general.sendKey', title: 'Enter — отправить, Shift+Enter — новая строка', kind: 'option' },
  { id: 'general.sendKey.ctrlEnter', path: GENERAL, parent: 'general.sendKey', title: 'Ctrl+Enter — отправить', kind: 'option', keywords: ['cmd enter', 'command enter'] },
  { id: 'general.shortcuts', path: 'settings/general/shortcuts', title: 'Сочетания клавиш', kind: 'section', keywords: ['горячие клавиши', 'хоткеи', 'шорткаты'] },
  ...shortcutSections('enter').flatMap((sec): E[] => [
    { id: 'shortcuts.' + sec.id, anchor: 'shortcuts.' + sec.id, path: 'settings/general/shortcuts', title: sec.title, kind: 'subsection' },
    ...sec.items.map((s): E => ({ id: `shortcuts.${sec.id}.${s.id}`, anchor: 'shortcut.' + s.id, path: 'settings/general/shortcuts', parent: 'shortcuts.' + sec.id, title: s.title, kind: 'row' })),
  ]),

  // ---------- Обои ----------
  { id: 'wallpaper', path: WP, title: 'Обои', kind: 'section', keywords: ['фон', 'обои чата', 'фон чата'] },
  { id: 'wallpaper.upload', path: WP, title: 'Загрузить изображение', kind: 'row', keywords: ['своё фото', 'картинка'] },
  { id: 'wallpaper.color', path: 'settings/general/wallpaper/color', title: 'Выбрать цвет', kind: 'section', keywords: ['цвет обоев', 'сплошной цвет'] },
  { id: 'wallpaper.color.presets', path: 'settings/general/wallpaper/color', title: 'Готовые цвета', kind: 'subsection' },
  { id: 'wallpaper.reset', path: WP, title: 'Сбросить', kind: 'row', keywords: ['обои по умолчанию'] },
  { id: 'wallpaper.blur', path: WP, title: 'Размытие', kind: 'toggle', keywords: ['размыть обои'] },
  { id: 'wallpaper.intensity', path: WP, title: 'Интенсивность узора', kind: 'row', keywords: ['яркость узора'] },
  { id: 'wallpaper.pattern', path: WP, title: 'Узор', kind: 'subsection', keywords: ['паттерн', 'рисунок'] },
  { id: 'wallpaper.colors', path: WP, title: 'Цвета и градиенты', kind: 'subsection', keywords: ['градиент'] },

  // ---------- Уведомления ----------
  { id: 'notifications', path: NOTIFY, title: 'Уведомления', kind: 'section', icon: 'bell', tile: 'red', keywords: ['оповещения', 'пуш', 'push'] },
  { id: 'notifications.web', path: NOTIFY, title: 'В браузере', kind: 'subsection' },
  { id: 'notifications.web.on', path: NOTIFY, parent: 'notifications.web', title: 'Уведомления', kind: 'toggle', keywords: ['разрешить уведомления', 'пуш', 'push'] },
  { id: 'notifications.web.background', path: NOTIFY, parent: 'notifications.web', title: 'Когда вкладка закрыта', kind: 'toggle', keywords: ['фоновые уведомления', 'push'] },
  { id: 'notifications.sound', path: NOTIFY, title: 'Звук', kind: 'toggle', keywords: ['звук уведомлений', 'без звука', 'беззвучно'] },
  { id: 'notifications.volume', path: NOTIFY, title: 'Громкость', kind: 'row', keywords: ['громко', 'тихо'] },
  { id: 'notifications.direct', path: NOTIFY, title: 'Личные чаты', kind: 'subsection' },
  { id: 'notifications.direct.on', path: NOTIFY, parent: 'notifications.direct', title: 'Уведомления', kind: 'toggle', keywords: ['личные сообщения'] },
  { id: 'notifications.direct.preview', path: NOTIFY, parent: 'notifications.direct', title: 'Предпросмотр сообщений', kind: 'toggle', keywords: ['превью', 'текст в уведомлении'] },
  { id: 'notifications.group', path: NOTIFY, title: 'Группы', kind: 'subsection' },
  { id: 'notifications.group.on', path: NOTIFY, parent: 'notifications.group', title: 'Уведомления', kind: 'toggle', keywords: ['групповые чаты'] },
  { id: 'notifications.group.preview', path: NOTIFY, parent: 'notifications.group', title: 'Предпросмотр сообщений', kind: 'toggle', keywords: ['превью', 'текст в уведомлении'] },

  // ---------- Конфиденциальность ----------
  { id: 'privacy', path: PRIVACY, title: 'Конфиденциальность', kind: 'section', icon: 'lock', tile: 'gray', keywords: ['приватность', 'безопасность'] },
  { id: 'privacy.password', path: PASSWORD, title: 'Облачный пароль', kind: 'section', keywords: ['пароль', '2fa', 'двухэтапная проверка', 'двухфакторная аутентификация'] },
  { id: 'privacy.password.set', path: PASSWORD, title: 'Установить пароль', kind: 'row', keywords: ['2fa'], when: noPw },
  { id: 'privacy.password.change', path: PASSWORD, title: 'Сменить пароль', kind: 'row', keywords: ['изменить пароль', 'подсказка'], when: hasPw },
  { id: 'privacy.password.email', path: PASSWORD, title: 'Почта для восстановления', kind: 'row', keywords: ['email', 'почта', 'восстановление пароля'], when: hasPw },
  { id: 'privacy.password.off', path: PASSWORD, title: 'Отключить пароль', kind: 'row', keywords: ['убрать пароль', '2fa'], when: hasPw },
  { id: 'privacy.passkeys', path: 'settings/privacy/passkeys', title: 'Паскеи', kind: 'section', keywords: ['passkey', 'ключ доступа', 'биометрия', 'face id', 'touch id', 'windows hello'] },
  { id: 'privacy.passkeys.create', path: 'settings/privacy/passkeys', title: 'Создать паскей', kind: 'row', keywords: ['добавить паскей'] },
  { id: 'privacy.blocked', path: 'settings/privacy/blocked', title: 'Заблокированные', kind: 'section', keywords: ['чёрный список', 'блокировка', 'заблокировать', 'бан'] },
  ...RULES.map(([k, title, keywords]): E => ({ id: 'privacy.rule.' + k, path: 'settings/privacy/rule/' + k, title, kind: 'section', keywords })),
  { id: 'privacy.rule.phone.discovery', anchor: 'privacy.rule.discovery', path: 'settings/privacy/rule/phone', title: 'Кто найдёт меня по номеру', kind: 'subsection', keywords: ['поиск по номеру'] },
  { id: 'privacy.screen', path: PRIVACY, title: 'Экран', kind: 'subsection' },
  { id: 'privacy.screen.blur', path: PRIVACY, parent: 'privacy.screen', title: 'Размывать, когда вкладка не в фокусе', kind: 'toggle', keywords: ['размытие', 'скрыть экран', 'приватный экран'] },
  { id: 'privacy.screen.title', path: PRIVACY, parent: 'privacy.screen', title: 'Не показывать чат в заголовке вкладки', kind: 'toggle', keywords: ['название вкладки'] },
  { id: 'privacy.screen.unread', path: PRIVACY, parent: 'privacy.screen', title: 'Не показывать непрочитанные в заголовке и значке', kind: 'toggle', keywords: ['счётчик', 'бейдж'] },
  { id: 'privacy.screen.notifyText', path: PRIVACY, parent: 'privacy.screen', title: 'Скрывать текст в уведомлениях', kind: 'toggle', keywords: ['превью уведомлений'] },

  // ---------- Папки ----------
  { id: 'folders', path: FOLDERS, title: 'Папки с чатами', kind: 'section', icon: 'folder', tile: 'blue', keywords: ['папки', 'вкладки', 'фильтры чатов'] },
  { id: 'folders.create', path: FOLDERS, title: 'Создать папку', kind: 'row', keywords: ['новая папка', 'добавить папку'] },
  { id: 'folders.position', path: FOLDERS, title: 'Вид вкладок', kind: 'subsection', keywords: ['расположение папок'] },
  { id: 'folders.position.left', path: FOLDERS, parent: 'folders.position', title: 'Слева', kind: 'option', keywords: ['вкладки слева', 'колонка папок'] },
  { id: 'folders.position.top', path: FOLDERS, parent: 'folders.position', title: 'Сверху', kind: 'option', keywords: ['вкладки сверху'] },

  // ---------- Данные и память ----------
  { id: 'data', path: DATA, title: 'Данные и память', kind: 'section', icon: 'storage', tile: 'green', keywords: ['память', 'хранилище', 'кэш', 'место', 'диск', 'трафик'] },
  { id: 'data.autoload', path: DATA, title: 'Автозагрузка медиа', kind: 'toggle', keywords: ['автоскачивание', 'скачивать автоматически'] },
  ...AUTOLOAD.flatMap(([k, title]): E[] => [
    { id: 'data.autoload.' + k, path: 'settings/data/autoload/' + k, title, kind: 'section', keywords: ['автозагрузка'] },
    ...AUTOLOAD_ROWS.map(([f, t]): E => ({ id: `data.autoload.${k}.${f}`, anchor: 'autoload.' + f, path: 'settings/data/autoload/' + k, title: t, kind: 'toggle' })),
  ]),
  { id: 'data.autoload.file.maxSize', anchor: 'autoload.maxSize', path: 'settings/data/autoload/file', title: 'Максимальный размер файла', kind: 'row', keywords: ['лимит загрузки'] },
  { id: 'data.autoload.reset', path: DATA, title: 'Сбросить настройки автозагрузки', kind: 'row' },
  { id: 'data.storage', path: DATA, title: 'Память', kind: 'subsection', keywords: ['занято', 'использование диска', 'место'] },
  { id: 'data.cache', path: DATA, title: 'Кэш медиа', kind: 'subsection', keywords: ['кеш'] },
  { id: 'data.cache.keep', path: DATA, parent: 'data.cache', title: 'Хранить медиа', kind: 'row', keywords: ['срок хранения'] },
  { id: 'data.cache.max', path: DATA, parent: 'data.cache', title: 'Максимальный размер кэша', kind: 'row', keywords: ['лимит кэша', 'кеш'] },
  { id: 'data.clearCache', path: DATA, title: 'Очистить кэш медиа', kind: 'row', keywords: ['удалить кэш', 'кеш', 'освободить место'] },
  { id: 'data.clearLocal', path: DATA, title: 'Очистить локальные данные', kind: 'row', keywords: ['удалить данные с устройства', 'сбросить'] },

  // ---------- Анимации и производительность ----------
  { id: 'performance', path: PERF, title: 'Анимации и производительность', kind: 'section', icon: 'rocket', tile: 'purple', keywords: ['батарея', 'энергосбережение', 'скорость', 'тормозит', 'медленно'] },
  { id: 'performance.level', path: PERF, title: 'Уровень анимаций', kind: 'row', keywords: ['меньше анимаций', 'эффекты'] },
  { id: 'performance.ui', path: PERF, title: 'Анимации интерфейса', kind: 'toggle', keywords: ['переходы', 'отключить анимации'] },
  { id: 'performance.wallpaper', path: PERF, title: 'Анимация обоев', kind: 'toggle', keywords: ['перелив фона'] },
  { id: 'performance.blur', path: PERF, title: 'Размытие', kind: 'toggle', keywords: ['стекло', 'прозрачность'] },
  { id: 'performance.autoplay', path: PERF, title: 'Автовоспроизведение', kind: 'subsection' },
  { id: 'performance.autoplay.gif', path: PERF, parent: 'performance.autoplay', title: 'GIF', kind: 'toggle', keywords: ['гифки', 'гиф'] },
  { id: 'performance.autoplay.video', path: PERF, parent: 'performance.autoplay', title: 'Видео', kind: 'toggle' },
  { id: 'performance.stickers', path: PERF, title: 'Анимированные стикеры', kind: 'toggle', keywords: ['стикеры'] },
  { id: 'performance.loopStickers', path: PERF, title: 'Зацикливать стикеры', kind: 'toggle', keywords: ['повтор стикеров'] },
  { id: 'performance.bigEmoji', path: PERF, title: 'Крупные эмодзи', kind: 'toggle', keywords: ['смайлики', 'большие эмодзи', 'emoji'] },

  // ---------- Активные сеансы ----------
  { id: 'sessions', path: SESSIONS, title: 'Активные сеансы', kind: 'section', icon: 'devices', tile: 'blue', keywords: ['устройства', 'сессии', 'где я вошёл', 'выйти на других устройствах'] },
  { id: 'sessions.link', path: SESSIONS, title: 'Подключить устройство', kind: 'row', keywords: ['qr', 'войти по qr', 'сканировать код'] },
  { id: 'sessions.terminateAll', path: SESSIONS, title: 'Завершить все другие сеансы', kind: 'row', keywords: ['выйти со всех устройств'] },
  { id: 'sessions.ttl', path: SESSIONS, title: 'Автоматически завершать сеансы', kind: 'row', keywords: ['автозавершение', 'неактивные сеансы'] },

  // ---------- Для разработчиков ----------
  { id: 'dev', path: 'settings/dev', title: 'Для разработчиков', kind: 'section', icon: 'bug', tile: 'gray', keywords: ['отладка', 'debug', 'журнал', 'синхронизация'], when: dev },
];

/** Значение data-setting строки пункта на странице (у раздела — нет: открывается сама страница). */
export const anchorOf = (e: Entry): string | null => (e.kind === 'section' ? null : (e as E).anchor ?? e.id);
