// Тема живёт в prefs; здесь — прежний API для Sidebar/Settings и переключатель «ночной режим».
import { getPrefs, setPref, isDark, type ThemePref } from './prefs';
export { isDark, type ThemePref };
export const loadTheme = (): ThemePref => getPrefs().theme;
export const applyTheme = (pref: ThemePref): void => setPref('theme', pref);
/** Переключатель светлая ↔ тёмная (меню, экран входа): к последней выбранной теме другой стороны. */
export const toggleNight = (dark: boolean): void => { const p = getPrefs(); setPref('theme', dark ? p.lastLight : p.lastDark); };
