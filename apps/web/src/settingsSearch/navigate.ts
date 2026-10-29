// Переход к пункту из поиска по настройкам: сразу на его страницу, поиск остаётся открытым («Назад» вернёт к выдаче).
import { go } from '../nav';
import type { Entry } from './match';
import { addSettingsRecent } from './recent';

export function openSetting(e: Entry): void {
  addSettingsRecent(e.id);
  void go(e.path);
}
