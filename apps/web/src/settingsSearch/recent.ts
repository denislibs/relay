// «Недавние» поиска по настройкам: пункты, открытые из поиска (на этом устройстве, до 5, новый — сверху).
const KEY = 'relay.settingsRecent';
export const RECENT_MAX = 5;

export const pushRecent = (list: string[], id: string): string[] => [id, ...list.filter((x) => x !== id)].slice(0, RECENT_MAX);

let recent: string[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
})();

function save(next: string[]): void {
  recent = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* приватный режим — только в памяти */ }
}
export const getSettingsRecent = (): string[] => recent;
export const addSettingsRecent = (id: string): void => save(pushRecent(recent, id));
export const clearSettingsRecent = (): void => save([]);
