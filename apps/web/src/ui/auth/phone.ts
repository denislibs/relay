import { AsYouType, getCountries, getCountryCallingCode, getExampleNumber, type CountryCode } from 'libphonenumber-js/min';
import examples from 'libphonenumber-js/examples.mobile.json';

/** Страны для выбора: название по-русски (Intl), флаг из букв ISO, код страны. Сортировка по названию. */
export interface Country { iso: CountryCode; name: string; code: string; flag: string }

const flagOf = (iso: string) => String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

let cache: Country[] | null = null;
export function countries(): Country[] {
  if (cache) return cache;
  let names: Intl.DisplayNames | null = null;
  try { names = new Intl.DisplayNames(['ru'], { type: 'region' }); } catch { names = null; }
  cache = getCountries()
    .map((iso) => ({ iso, name: names?.of(iso) ?? iso, code: getCountryCallingCode(iso), flag: flagOf(iso) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return cache;
}

export const countryByIso = (iso: string | null | undefined) => (iso ? countries().find((c) => c.iso === iso) ?? null : null);

/** Поиск страны: по названию, ISO, коду и инициалам («ОАЭ», «сш»). */
export function searchCountries(q: string): Country[] {
  const s = q.trim().toLowerCase().replace(/^\+/, '');
  if (!s) return countries();
  const hit = countries().filter((c) => {
    const n = c.name.toLowerCase();
    const initials = n.split(/[\s-]+/).map((w) => w[0]).join('');
    return n.startsWith(s) || n.includes(' ' + s) || c.iso.toLowerCase() === s || c.code.startsWith(s) || initials.startsWith(s);
  });
  return hit.length ? hit : countries();
}

/** Страна по умолчанию — из языка браузера («ru-RU» → Россия). */
export function guessCountry(): Country | null {
  for (const l of navigator.languages ?? [navigator.language]) {
    const region = /-([A-Z]{2})$/i.exec(l)?.[1]?.toUpperCase();
    const c = countryByIso(region);
    if (c) return c;
  }
  return null;
}

/**
 * Ввод номера: оставляем «+» и цифры (не больше 15 цифр — E.164), форматируем по стране как при вводе,
 * определяем страну и строим серый «хвост» шаблона из номера-примера («‒‒ ‒‒»).
 */
export function formatPhone(raw: string, fallback: CountryCode | null): { value: string; digits: string; country: Country | null; ghost: string; complete: boolean } {
  let digits = raw.replace(/\D/g, '').slice(0, 15);
  if (!digits) return { value: '+', digits: '', country: null, ghost: '', complete: false };
  const t = new AsYouType();
  const value = t.input('+' + digits);
  const iso = t.getCountry() ?? (fallback && getCountryCallingCode(fallback) === t.getCallingCode() ? fallback : null)
    ?? countries().find((c) => c.code === t.getCallingCode())?.iso ?? null;
  const country = countryByIso(iso);
  let ghost = '';
  if (iso) {
    const ex = getExampleNumber(iso, examples as never);
    const full = ex ? new AsYouType().input(ex.number) : '';
    if (full.length > value.length) ghost = full.slice(value.length).replace(/\d/g, '‒');
  }
  return { value, digits, country, ghost, complete: t.isValid() };
}
