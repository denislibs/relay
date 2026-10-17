import { PanelHeader } from '@relay/ui';
import { back, pageIndex, PAGES } from '../../nav';

// Заглушки страниц, которых ещё нет: даём навигации живую цель; следующие задачи заменяют по одной.
const TITLES: Record<string, string> = {
  'settings/profile': 'Изменить профиль',
  'settings/general': 'Основные настройки',
  'settings/general/wallpaper': 'Обои',
  'settings/notifications': 'Уведомления',
  'settings/privacy': 'Конфиденциальность',
  'settings/privacy/rule/:key': 'Правило приватности',
  'settings/privacy/rule/:key/allow': 'Всегда разрешать',
  'settings/privacy/rule/:key/deny': 'Всегда запрещать',
  'settings/privacy/blocked': 'Чёрный список',
  'settings/data': 'Данные и память',
  'settings/data/autoload/:type': 'Автозагрузка медиа',
  'settings/performance': 'Производительность',
  'settings/sessions': 'Устройства',
  'settings/dev': 'Разработчик',
  'settings/dev/:tab': 'Разработчик',
  contacts: 'Контакты',
  'contacts/:userId/edit': 'Изменить контакт',
};

export function Placeholder({ path }: { path: string }) {
  const title = TITLES[PAGES[pageIndex(path)]] ?? 'Раздел';
  return (
    <div class="rl-sidepage" aria-label={title}>
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title={title} onClose={() => void back()} />
      <div class="rl-settings" />
    </div>
  );
}
