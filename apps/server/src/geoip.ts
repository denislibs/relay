// Место входа по IP: страна и город для «Новый вход» и списка сеансов. База — файл MMDB (формат MaxMind:
// GeoLite2-City или бесплатная DB-IP City Lite, CC BY 4.0), путь — GEOIP_DB; скачать — tools/geoip/fetch.sh.
// Базы нет — места нет (null), вход работает как раньше. Частные адреса — «Локальная сеть».
import { Reader } from 'mmdb-lib';

export interface Place { country: string | null; city: string | null; local?: boolean }

type CityRecord = { country?: { iso_code?: string; names?: Record<string, string> }; city?: { names?: Record<string, string> } };

let reader: Promise<Reader<CityRecord> | null> | null = null;
function db(): Promise<Reader<CityRecord> | null> {
  return reader ??= (async () => {
    const path = process.env.GEOIP_DB;
    if (!path || !(await Bun.file(path).exists())) return null;
    return new Reader<CityRecord>(Buffer.from(await Bun.file(path).arrayBuffer()));
  })().catch((e) => { console.warn('geoip:', String(e)); return null; });
}
/** Тесты: своя база или её отсутствие. */
export function setGeoReader(r: Reader<CityRecord> | null): void { reader = Promise.resolve(r); }

/** Частный, локальный или служебный адрес — места у него нет. */
export function isPrivateIp(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
}

const name = (names: Record<string, string> | undefined) => names?.ru ?? names?.en ?? null;

export async function lookupIp(ip: string | null): Promise<Place | null> {
  if (!ip) return null;
  if (isPrivateIp(ip)) return { country: null, city: null, local: true };
  const r = await db();
  if (!r) return null;
  try {
    const rec = r.get(ip.replace(/^::ffff:/, ''));
    if (!rec) return null;
    return { country: name(rec.country?.names), city: name(rec.city?.names) };
  } catch { return null; }
}

/** «Москва, Россия» / «Россия» / «Локальная сеть» / null. */
export function placeText(p: { country?: string | null; city?: string | null; local?: boolean } | null | undefined): string | null {
  if (!p) return null;
  if (p.local) return 'Локальная сеть';
  return [p.city, p.country].filter(Boolean).join(', ') || null;
}
