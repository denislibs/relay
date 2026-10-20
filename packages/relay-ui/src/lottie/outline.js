// Векторный силуэт стикера из сжатого контура Telegram («vector thumbnails», core.telegram.org/api/files).
// Байт ≥ 192 — символ из таблицы (команды пути и цифры), 128..191 — «,» и число, 64..127 — «-» и число, < 64 — число.
const LOOKUP = 'AACAAAAHAAALMAAAQASTAVAAAZaacaaaahaaalmaaaqastava.az0123456789-,';

/** base64 из meta.json → строка SVG path «M…z» (пусто, если контура нет). */
export function decodeOutline(b64) {
  if (!b64) return '';
  let bytes;
  try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { return ''; }
  let path = 'M';
  for (const b of bytes) {
    if (b >= 192) { path += LOOKUP[b - 192]; continue; }
    if (b >= 128) path += ',';
    else if (b >= 64) path += '-';
    path += String(b & 63);
  }
  return path + 'z';
}
