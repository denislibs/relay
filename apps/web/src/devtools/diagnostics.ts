// «Скачать диагностику»: один JSON — обзор, последние 2000 событий журнала, ошибки. Без тел сообщений:
// строки body/text/bio/thumb заменяются длиной (в журнале они и так обрезаны до 40 символов — здесь убираем совсем);
// личные поля профиля и контакта (телефон, день рождения, имена, файлы) — тоже: файл прикладывают к баг-репорту.

const SECRET = new Set(['body', 'text', 'bio', 'thumb', 'draft', 'note', 'q', 'query', 'phone', 'birthday', 'firstName', 'lastName', 'name', 'username']);
const MAX_DEPTH = 8;

export function redact(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '…';
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = !SECRET.has(k) || x == null ? redact(x, depth + 1) : typeof x === 'string' ? `‹${x.length} симв.›` : '‹скрыто›';
  }
  return out;
}

/** 2026-10-17T12-30-05 — без двоеточий (имя файла). */
export const fileStamp = (d = new Date()): string => d.toISOString().slice(0, 19).replace(/:/g, '-');

export function diagnosticsFile(build: string, data: Record<string, unknown>, now = new Date()): { name: string; json: string } {
  return { name: `relay-diagnostics-${build}-${fileStamp(now)}.json`, json: JSON.stringify(redact({ build, at: now.toISOString(), ...data }), null, 2) };
}

/** Отдать файл браузеру: Blob + временная ссылка <a download>. */
export function downloadText(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
