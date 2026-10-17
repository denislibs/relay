// Тема живёт в prefs; здесь — прежний API для Sidebar/Settings.
import { getPrefs, setPref, isDark, type ThemePref } from './prefs';
export { isDark, type ThemePref };
export const loadTheme = (): ThemePref => getPrefs().theme;
export const applyTheme = (pref: ThemePref): void => setPref('theme', pref);
