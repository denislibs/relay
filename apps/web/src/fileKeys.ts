// Ключи зашифрованных вложений на странице (packages/protocol/src/fileCrypto.ts). Ключ файла приходит в самом
// вложении сообщения (attachment.key); Service Worker, расшифровывая /files/<id>, берёт его отсюда:
//   1) всё, что приходит от движка (патчи лент и списков, ответы на вызовы), проходит через rememberKeysIn —
//      ключи запоминаются в памяти (синхронно, до того как элемент получит src) и в IndexedDB (для SW и офлайна);
//   2) SW не нашёл ключа в IndexedDB — спрашивает вкладку (attachments:need-key), она отвечает из памяти.
import { fileKeysStore } from './attachmentsOnDevice';

const known = new Map<string, string>();
const pending: [string, string][] = [];
let flushing = false;

export function rememberKey(id: string, key: string): void {
  if (!id || !key || known.get(id) === key) return;
  known.set(id, key);
  pending.push([id, key]);
  if (!flushing) {
    flushing = true;
    queueMicrotask(() => { const batch = pending.splice(0); flushing = false; void fileKeysStore.putMany(batch).catch(() => {}); });
  }
}

const NESTED = ['attachment', 'last', 'message', 'messages', 'hits', 'items', 'upsert', 'list', 'quote'];
/** Найти вложения с ключом в данных движка (сообщение, список сообщений, патч, ответ поиска) и запомнить ключи. */
export function rememberKeysIn(v: unknown, depth = 0): void {
  if (!v || typeof v !== 'object' || depth > 5) return;
  if (Array.isArray(v)) { for (const x of v) rememberKeysIn(x, depth + 1); return; }
  const o = v as Record<string, unknown>;
  const a = o.attachment as { id?: string; enc?: number; key?: string } | null | undefined;
  if (a && a.enc === 1 && a.id && a.key) rememberKey(a.id, a.key);
  if (o.enc === 1 && typeof o.id === 'string' && typeof o.key === 'string') rememberKey(o.id, o.key);   // само вложение
  for (const k of NESTED) if (k !== 'attachment' && o[k]) rememberKeysIn(o[k], depth + 1);
}

export const keyFor = (id: string): string | undefined => known.get(id);

/** Ответы на вопросы Service Worker'а «какой ключ у файла» (его IndexedDB ещё не догнала память). */
export function startFileKeyService(): void {
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const d = e.data as { type?: string; id?: string } | null;
    if (d?.type !== 'attachments:need-key' || !d.id) return;
    e.ports[0]?.postMessage({ id: d.id, key: known.get(d.id) ?? null });
  });
}

/** Выход / «Очистить кэш»: забыть ключи и в памяти. */
export function forgetKeys(): void { known.clear(); }
