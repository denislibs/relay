/* ---------- контакт, геопозиция, кубики (как messageMediaContact / Geo / Venue / Dice в Telegram) ---------- */

/** Поделиться пользователем Relay: id (кнопка «Написать») и имя на момент отправки. */
export interface ContactCard { userId: number | null; name: string; phone?: string | null }

/** Точка на карте; с названием — место (venue): название и адрес под картой. */
export interface GeoPoint { lat: number; lng: number; title?: string; address?: string }

/** Кубики: эмодзи и выпавшее значение (выбирает сервер, клиенту не верим). */
export interface Dice { emoji: DiceEmoji; value: number }
export type DiceEmoji = '🎲' | '🎯' | '🏀' | '⚽' | '🎳' | '🎰';
/** Сколько значений у каждого: кубик и дартс — 6, мяч — 5, слоты — 64 (как в Telegram). */
export const DICE_FACES: Record<DiceEmoji, number> = { '🎲': 6, '🎯': 6, '🏀': 5, '⚽': 5, '🎳': 6, '🎰': 64 };
export const isDiceEmoji = (s: unknown): s is DiceEmoji => typeof s === 'string' && Object.prototype.hasOwnProperty.call(DICE_FACES, s);

export const GEO_TITLE_MAX = 128;
export const GEO_ADDRESS_MAX = 256;
export const CONTACT_NAME_MAX = 64;

/** Проверка точки от клиента: широта −90…90, долгота −180…180, 6 знаков после запятой; название/адрес — в пределах. */
export function normalizeGeo(raw: unknown): GeoPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lat = Number(r.lat), lng = Number(r.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const line = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const title = line(r.title, GEO_TITLE_MAX), address = line(r.address, GEO_ADDRESS_MAX);
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return { lat: round(lat), lng: round(lng), ...(title ? { title } : {}), ...(address ? { address } : {}) };
}

/** Тайл карты (схема XYZ, как у OpenStreetMap) и смещение точки внутри него, в пикселях 256×256. */
export function geoTile(lat: number, lng: number, zoom: number): { x: number; y: number; px: number; py: number } {
  const n = 2 ** zoom, rad = (lat * Math.PI) / 180;
  const fx = ((lng + 180) / 360) * n;
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const x = Math.floor(fx), y = Math.floor(fy);
  return { x, y, px: Math.round((fx - x) * 256), py: Math.round((fy - y) * 256) };
}
