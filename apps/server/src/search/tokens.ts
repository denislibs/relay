// Токены поиска вместо текста: каждое слово и его префиксы (2…20 букв) → HMAC-SHA256 ключом поиска, 9 байт,
// записанные буквами a–p (Meilisearch не разрежет такой токен на части). В индексе — только токены: утечка
// Meilisearch не даёт текста, только совпадения слов между документами. Опечатки не прощаются (у токенов нет
// «соседей»), поиск по началу слова — за счёт префиксов. Запрос: каждое слово → токен того же вида.
import { createHmac } from 'node:crypto';
import { searchKey } from '../crypto/searchKey';

const MIN_PREFIX = 2, MAX_PREFIX = 20, MAX_WORDS = 600;

/** Слова для поиска: NFKC, нижний регистр, ё → е, только буквы и цифры. */
export function words(text: string): string[] {
  return (text.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_WORDS);
}

const letters = (b: Buffer) => { let s = ''; for (const x of b) s += String.fromCharCode(97 + (x >> 4), 97 + (x & 15)); return s; };
const token = (key: Buffer, part: string) => letters(createHmac('sha256', key).update('w|' + part).digest().subarray(0, 9));

/** Токены документа: слово целиком и его префиксы, без повторов, через пробел. */
export async function indexTokens(...texts: (string | null | undefined)[]): Promise<string> {
  const key = await searchKey();
  const out = new Set<string>();
  for (const t of texts) for (const w of words(t ?? '')) {
    const chars = [...w];
    if (chars.length < MIN_PREFIX) { out.add(token(key, w)); continue; }
    for (let n = MIN_PREFIX; n <= Math.min(chars.length, MAX_PREFIX); n++) out.add(token(key, chars.slice(0, n).join('')));
  }
  return [...out].join(' ');
}

/** Запрос → токены (каждое слово ищется как начало слова). Длиннее MAX_PREFIX — по первым MAX_PREFIX буквам. */
export async function queryTokens(q: string): Promise<string> {
  const key = await searchKey();
  return [...new Set(words(q).map((w) => token(key, [...w].slice(0, MAX_PREFIX).join(''))))].join(' ');
}
