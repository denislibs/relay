import type { AdminRight, CommunityKind, MemberRight } from '@relay/protocol';

// Тексты прав и медленного режима: без зависимостей, общие для экранов управления и журнала действий.

export const MEMBER_RIGHT_TEXT: Record<MemberRight, string> = {
  text: 'Отправка сообщений', photos: 'Фото', videos: 'Видео', files: 'Файлы', music: 'Музыка', voice: 'Голосовые сообщения', stickers: 'Стикеры и GIF',
  round: 'Видеосообщения', links: 'Превью ссылок', react: 'Реакции', invite: 'Добавление участников', pin: 'Закрепление сообщений', info: 'Изменение профиля группы',
};
export const ADMIN_RIGHT_TEXT: Record<AdminRight, string> = {
  info: 'Изменение профиля группы', post: 'Публикация сообщений', edit: 'Изменение чужих публикаций', delete: 'Удаление сообщений', ban: 'Блокировка пользователей', invite: 'Пригласительные ссылки', pin: 'Закрепление сообщений', calls: 'Управление звонками', addAdmins: 'Назначение администраторов',
};
/** Права админа канала — своими словами (у канала публикации и подписчики, а не сообщения и участники). */
export const CHANNEL_ADMIN_RIGHT_TEXT: Partial<Record<AdminRight, string>> = {
  info: 'Изменение профиля канала', post: 'Публикация сообщений', edit: 'Изменение чужих публикаций', delete: 'Удаление чужих публикаций',
  ban: 'Блокировка подписчиков', invite: 'Добавление подписчиков', addAdmins: 'Назначение администраторов',
};
export const adminRightText = (k: AdminRight, kind: CommunityKind) => (kind === 'channel' ? CHANNEL_ADMIN_RIGHT_TEXT[k] : undefined) ?? ADMIN_RIGHT_TEXT[k];

export const SLOW_TEXT: Record<number, string> = { 0: 'Выкл.', 10: '10 с', 30: '30 с', 60: '1 мин', 300: '5 мин', 900: '15 мин', 3600: '1 ч' };
