import { Avatar, EmptyState, FolderTabs, InfoRow, LazyImage, PanelHeader, SlideStack, Switch } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { chatMedia, focusMessage } from '../data';
import { fileSize } from './format';
import { useEffect, useState } from 'preact/hooks';
import { syncMuted } from '../notify';
import { setGlobal, useGlobal } from '../global';
import { clock, dayLabel, lastSeenText } from './format';

const TABS = ['media', 'files', 'links'];
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const close = () => setGlobal({ infoOpen: false });

// уведомления выключаются только на этом устройстве (как «Без звука» локально): список chatId в localStorage
const MUTED_KEY = 'relay.muted';
export function loadMuted(): number[] { try { return JSON.parse(localStorage.getItem(MUTED_KEY) ?? '[]'); } catch { return []; } }
function toggleMuted(chatId: number, muted: number[]): void {
  const next = muted.includes(chatId) ? muted.filter((x) => x !== chatId) : [...muted, chatId];
  try { localStorage.setItem(MUTED_KEY, JSON.stringify(next)); } catch { /* приватный режим */ }
  setGlobal({ muted: next });
  syncMuted();
}

/** Правая панель «Информация» о собеседнике или группе — как User Info в Telegram. */
export function Info() {
  const chatId = useGlobal((s) => s.openChatId)!;
  const chat = useGlobal((s) => s.chats.find((c) => c.id === s.openChatId));
  const peer = useGlobal((s) => s.peer);
  const messages = useGlobal((s) => s.messages);
  const muted = useGlobal((s) => s.muted);
  const [tab, setTab] = useState('media');
  // медиа и файлы чата — с сервера (вся история), при открытии вкладки
  const [media, setMedia] = useState<{ photo?: Item[]; file?: Item[] }>({});
  useEffect(() => {
    if (tab === 'links') return;
    const kind = tab === 'media' ? 'photo' : 'file';
    let live = true;
    chatMedia(chatId, kind).then((list) => { if (live) setMedia((m) => ({ ...m, [kind]: list })); }).catch(() => {});
    return () => { live = false; };
  }, [tab, chatId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const title = (chat?.title as string) || 'Чат №' + chatId;
  const group = chat?.kind === 'group';
  const myPeer = peer && chat?.peerId === peer.userId && peer.known ? peer : null;
  const subtitle = group ? 'группа' : myPeer ? lastSeenText(!!myPeer.online, myPeer.lastSeen as string | null) : '';
  const links = messages
    .flatMap((m) => ((m.body as string).match(URL_RE) ?? []).map((url) => ({ url, at: m.createdAt as string, key: m.key + url })))
    .reverse();

  return (
    <>
      <PanelHeader icon="close" closeLabel="Закрыть" title="Информация" onClose={close} />
      <div class="rl-aside-body">
        <div class="rl-profile">
          <Avatar name={title} size={120} />
          <div class="rl-profile-name">{title}</div>
          <div class={'rl-profile-sub' + (myPeer?.online ? ' app-online' : '')}>{subtitle || ' '}</div>
        </div>
        <div class="rl-aside-group">
          <InfoRow icon={group ? 'community' : 'contact'} title={title} subtitle={group ? 'Название группы' : 'Имя'} />
          <InfoRow
            icon={muted.includes(chatId) ? 'bellOff' : 'bell'}
            title="Уведомления"
            subtitle={muted.includes(chatId) ? 'Выключены на этом устройстве' : 'Включены'}
            trailing={<Switch id="info-notify" label="Уведомления" checked={!muted.includes(chatId)} onChange={() => toggleMuted(chatId, muted)} />}
          />
        </div>
        <div class="rl-aside-tabs">
          <FolderTabs active={tab} onChange={setTab} items={[
            { id: 'media', label: 'Медиа' },
            { id: 'files', label: 'Файлы' },
            { id: 'links', label: 'Ссылки', count: links.length || undefined },
          ]} />
        </div>
        <div class="rl-aside-pages">
          <SlideStack variant="tabs" order={TABS} active={tab} render={(k: string) =>
            k === 'media' && media.photo?.length ? (
              <div class="app-media-grid">
                {media.photo.map((m) => { const a = m.attachment as { id: string; thumb?: string; name: string }; return (
                  <button key={m.key} type="button" class="app-media-cell" aria-label={a.name} onClick={() => focusMessage({ id: m.id as number, sort: m.id as number })}>
                    <LazyImage src={`/files/${a.id}`} thumb={a.thumb} alt={a.name} />
                  </button>
                ); })}
              </div>
            ) : k === 'files' && media.file?.length ? (
              <ul class="rl-aside-links">
                {media.file.map((m) => { const a = m.attachment as { id: string; name: string; size: number }; return (
                  <li key={m.key}><a href={`/files/${a.id}?download=1`} download={a.name}><b>{a.name}</b><small>{fileSize(a.size)} · {dayLabel(m.createdAt as string)}</small></a></li>
                ); })}
              </ul>
            ) : k === 'links' && links.length ? (
              <ul class="rl-aside-links">
                {links.map((l) => (
                  <li key={l.key}><a href={l.url} target="_blank" rel="noopener noreferrer"><b>{l.url}</b><small>{dayLabel(l.at)}, {clock(l.at)}</small></a></li>
                ))}
              </ul>
            ) : (
              <EmptyState
                kind={k}
                title={k === 'media' ? 'Здесь пока пусто' : k === 'files' ? 'Файлов пока нет' : 'Ссылок пока нет'}
                text={k === 'media' ? 'Фото и видео из этого чата появятся здесь.' : k === 'files' ? 'Документы и архивы из переписки соберутся здесь.' : 'Ссылки из сообщений этого чата появятся здесь.'}
              />
            )
          } />
        </div>
      </div>
    </>
  );
}
