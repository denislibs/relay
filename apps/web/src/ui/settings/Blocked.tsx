import { ChatRow, ChatRowSkeleton, ContactPicker, EmptyState, Fab, Menu, Modal, PanelHeader, Presence, Section, useMinVisible } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import { back } from '../../nav';
import { blockUser, registerPrefetch, unblockUser } from '../../settingsData';
import { candidates } from './privacyLogic';

// список живёт в движке (подписка blocked с запуска): предзагружать нечего
registerPrefetch('settings/privacy/blocked', () => {});

const FOOTER = 'Заблокированные пользователи не могут писать вам и не видят, когда вы были в сети.';
const about = (b: Item) => (b.username ? '@' + String(b.username) : b.phone ? String(b.phone) : '');

/** «Заблокированные»: список (меню строки — «Разблокировать»), FAB «+» — выбрать, кого заблокировать. */
export function Blocked() {
  const list = useGlobal((s) => s.blocked);
  const loaded = useGlobal((s) => s.blockedLoaded);
  const phase = useGlobal((s) => s.status.phase);
  const me = useGlobal((s) => s.me!.userId);
  const contacts = useGlobal((s) => s.contacts);
  const chats = useGlobal((s) => s.chats);
  const [menu, setMenu] = useState<{ x: number; y: number; userId: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const waiting = !loaded && !list.length && phase !== 'offline';
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const ids = new Set(list.map((b) => b.userId as number));
  const people = candidates(contacts, chats, me).filter((p) => !ids.has(p.id));

  return (
    <div class="rl-sidepage" aria-label="Заблокированные">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Заблокированные" onClose={() => void back()} />
      <div class="rl-settings">
        <div class="app-listwrap">
          <Presence show={skeleton} exitMs={280}>
            <div class="app-skel" aria-busy="true" aria-label="Загрузка списка">
              <Section>{[0, 1, 2].map((i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}</Section>
            </div>
          </Presence>
          {waiting || skeleton ? null : list.length ? (
            <Section footer={FOOTER}>
              <div role="list">
                {list.map((b) => (
                  <div key={b.key} role="listitem">
                    <ChatRow
                      name={String(b.name || 'Пользователь')}
                      preview={about(b)}
                      aria-haspopup="menu"
                      onClick={(e: MouseEvent) => setMenu({ x: e.clientX, y: e.clientY, userId: b.userId as number })}
                      onContextMenu={(e: MouseEvent) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, userId: b.userId as number }); }}
                    />
                  </div>
                ))}
              </div>
            </Section>
          ) : (
            <>
              <EmptyState kind="contacts" title="Никого нет" text="Здесь появятся люди, которых вы заблокируете." />
              <p class="rl-sect-footer app-blocked-footer">{FOOTER}</p>
            </>
          )}
        </div>
      </div>
      {menu ? (
        <>
          <div class="rl-msgmenu-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div class="rl-msgmenu" style={{ left: Math.min(menu.x, innerWidth - 240), top: Math.min(menu.y, innerHeight - 80) }}>
            <Menu label="Действия" onClose={() => setMenu(null)} items={[{ icon: 'block', label: 'Разблокировать', onClick: () => { void unblockUser(menu.userId); setMenu(null); } }]} />
          </div>
        </>
      ) : null}
      <div class="rl-fab-slot"><Fab icon="plus" label="Заблокировать пользователя" onClick={() => setPicking(true)} /></div>
      {picking ? (
        <Modal title="Заблокировать пользователя" onClose={() => setPicking(false)}>
          <div class="app-block-pick">
            <ContactPicker
              contacts={people} searchLabel="Поиск людей" placeholder="Имя или @имя пользователя"
              empty="Заблокировать можно собеседника или человека из контактов."
              onPick={(p: { id: number }) => { setPicking(false); void blockUser(p.id); }}
            />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
