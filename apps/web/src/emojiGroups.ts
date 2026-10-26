// Группы эмодзи Telegram (GET /emoji-groups): чипы в строке поиска панели эмодзи и стикеров. Грузятся один раз
// за сессию, когда панель впервые открылась; без ответа (нет ассетов, нет сети) панель берёт свои фильтры (QUICK).
import type { EmojiGroup, EmojiGroupsCatalog } from '@relay/protocol';
import { useEffect, useState } from 'preact/hooks';

let cat: EmojiGroupsCatalog | null = null;
let state: 'idle' | 'loading' | 'done' = 'idle';
const listeners = new Set<() => void>();

function load(): void {
  if (state !== 'idle') return;
  state = 'loading';
  fetch('/emoji-groups', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() as Promise<EmojiGroupsCatalog> : Promise.reject(new Error(String(r.status)))))
    .then((j) => { cat = j; }, () => { cat = null; })
    .finally(() => { state = 'done'; for (const fn of listeners) fn(); });
}

/** Группы для вкладки: undefined — ещё в пути (чипов пока нет), [] — своих групп нет, берите запасные. */
export function useEmojiGroups(kind: 'emoji' | 'sticker'): EmojiGroup[] | undefined {
  const [, redraw] = useState(0);
  useEffect(() => {
    load();
    const fn = () => redraw((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return state === 'done' ? cat?.[kind] ?? [] : undefined;
}
