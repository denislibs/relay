// Личный канал в профиле (как в Telegram): кандидаты для «Изменить профиль» и последний пост канала для строки.
// Кандидаты (GET /me/personal-channels через движок) предзагружаются при входе в «Настройки», чтобы карточка не
// ждала сети; пост — кэш движка (IndexedDB) сразу, затем тихо с сервера (GET /groups/:id).
import { useEffect, useState } from 'preact/hooks';
import { useKeyedState } from './keyedState';
import type { Message, PersonalChannel } from '@relay/protocol';
import { callEngine, registerPrefetch } from './settingsData';
import type { LastMessage } from './ui/preview';

let candidates: PersonalChannel[] | null = null;
let loading: Promise<PersonalChannel[] | null> | null = null;

/** Каналы, которые можно поставить в профиль; null — без сети (и прежнего ответа нет). */
export function loadPersonalChannels(): Promise<PersonalChannel[] | null> {
  loading ??= (callEngine({ type: 'personalChannels' }) as Promise<{ channels: PersonalChannel[] } | { offline: true }>)
    .then((r) => ('channels' in r ? (candidates = r.channels) : candidates), () => candidates)
    .finally(() => { loading = null; });
  return loading;
}
export const knownPersonalChannels = (): PersonalChannel[] | null => candidates;
export function resetPersonalChannels(): void { candidates = null; posts.clear(); }

registerPrefetch('settings/profile', () => { void loadPersonalChannels(); });

/** Последний пост для строки: поля, которые рисует ChatRow (как last строки списка чатов в queries.ts). */
export type ChannelLast = LastMessage & { id: number; createdAt: string };
export function lastOf(m: Message): ChannelLast {
  const a = m.attachment ?? null;
  return {
    id: m.id, createdAt: m.createdAt, senderId: m.senderId, body: m.body, deleted: !!m.deleted, kind: m.kind ?? 'text',
    attachmentId: a?.id ?? null, attachmentName: a?.name ?? null, attachmentTitle: a?.title ?? null, attachmentPerformer: a?.performer ?? null,
    entities: m.entities ?? null, thumb: a?.thumb ?? null, mime: a?.mime ?? null,
    ...(m.sticker ? { sticker: m.sticker } : {}), ...(m.service ? { service: m.service } : {}),
  };
}

/** unknown — ещё не знаем (строка без превью); gone — сервер канал не показывает (строку схлопнуть). */
export type ChannelPostState = { state: 'unknown' } | { state: 'gone' } | { state: 'known'; last: ChannelLast | null };
type Answer = { last: Message | null; at: number } | { gone: true } | null;
const toState = (r: Answer): ChannelPostState | null => (!r ? null : 'gone' in r ? { state: 'gone' } : { state: 'known', last: r.last ? lastOf(r.last) : null });

// последний ответ по каналу в памяти вкладки: повторное открытие профиля рисует пост первым же кадром
const posts = new Map<number, ChannelPostState>();

export function useChannelPost(chatId: number | null | undefined): ChannelPostState {
  const [st, setSt] = useKeyedState<number | null | undefined, ChannelPostState>(chatId, (id) => (id ? posts.get(id) ?? { state: 'unknown' } : { state: 'unknown' }));
  useEffect(() => {
    if (!chatId) { setSt({ state: 'unknown' }); return; }
    setSt(posts.get(chatId) ?? { state: 'unknown' });
    let live = true;
    const put = (s: ChannelPostState | null) => { if (!s) return; posts.set(chatId, s); if (live) setSt(s); };
    void (async () => {
      if (!posts.has(chatId)) put(toState(await (callEngine({ type: 'channelPost', chatId, cached: true }) as Promise<Answer>).catch(() => null)));
      put(toState(await (callEngine({ type: 'channelPost', chatId }) as Promise<Answer>).catch(() => null)));
    })();
    return () => { live = false; };
  }, [chatId]);
  return st;
}
