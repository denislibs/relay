// Переход к пункту из поиска по настройкам: сразу на его страницу (без промежуточных), поиск остаётся открытым —
// «Назад» вернёт к выдаче с тем же запросом. Строка пункта прокручивается в центр и вспыхивает.
import { getGlobal } from '../global';
import { go } from '../nav';
import { flashSetting } from '../ui/settings/highlight';
import { anchorOf } from './entries';
import type { Entry } from './match';
import { addSettingsRecent } from './recent';

export function openSetting(e: Entry): void {
  addSettingsRecent(e.id);
  const anchor = anchorOf(e);   // раздел — сама страница, подсвечивать нечего
  void go(e.path, { direct: true }).then(() => {
    if (anchor && getGlobal().sidebarView === e.path) flashSetting(e.path, anchor);
  });
}
