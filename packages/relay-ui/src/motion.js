/* Лёгкие помощники без компонентов — их берёт и слой данных приложения (apps/web: data.ts, settingsData.ts…),
   который стартует раньше интерфейса и не должен тянуть за собой UI-кит (kit.js с иконками, more.js с twallpaper).
   kit.js и more.js реэкспортируют их — для остального кода ничего не меняется. */
import { beginHeavyAnimation } from './schedule.js';

/* Система просит меньше движения ИЛИ в настройках выключены анимации интерфейса (data-anim="0" на <html>). */
var reducedMq = null;   // один MediaQueryList: matchMedia на каждый вызов заметен в профиле (стикеры, анимации)
export function reducedMotion() {
  if (document.documentElement.dataset.anim === '0') return true;
  if (!reducedMq && window.matchMedia) reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  return !!(reducedMq && reducedMq.matches);
}

/* Цвет собеседника: 7 оттенков палитры (--peer-0…6). У кого есть id — id % 7, иначе хэш имени (kit.js nameTone). */
export var PEER_COLORS = 7;
export function peerTone(id) { return Math.abs(Math.trunc(id)) % PEER_COLORS; }

/* Обои на экране (Wallpaper в more.js регистрирует свои twallpaper здесь). */
export var wallpapers = [];
export function wpMotion() { return !reducedMotion() && document.documentElement.dataset.wpanim !== '0'; }
/* Shift every mounted wallpaper's gradient one step — call on send / receive, like Telegram. */
export function nudgeWallpaper() {
  if (!wpMotion()) return; // «Анимация обоев» выключена — градиент стоит
  wallpapers.forEach(function (w) { var end = beginHeavyAnimation(700); w.toNextPosition(end); });
}
