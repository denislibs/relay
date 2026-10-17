import { AsidePanel, EmptyState, FloatShell, Presence, SideFrame, SlideStack, Toast } from '@relay/ui';
import { useRef } from 'preact/hooks';
import { useGlobal } from '../global';
import { orderFor } from '../nav';
import { useWallpaper } from '../wallpapers';
import { Chat } from './Chat';
import { Info } from './Info';
import { Login } from './Login';
import { NewChat } from './NewChat';
import { LegacyPage } from './Settings';
import { General } from './settings/General';
import { Main } from './settings/Main';
import { Placeholder } from './settings/Placeholder';
import { Profile } from './settings/Profile';
import { Wallpaper } from './settings/Wallpaper';
import { Contacts } from './contacts/Contacts';
import { EditContact } from './contacts/EditContact';
import { NewContact } from './contacts/NewContact';
import { Sidebar } from './Sidebar';


const LEGACY: Record<string, string> = { 'settings/notifications': 'Уведомления', 'settings/data': 'Данные и память' };

// ширина списка чатов, которую пользователь вытянул за край (null — по умолчанию)
const SIDE_KEY = 'relay.sideWidth';
const savedSide = (() => { try { const v = Number(localStorage.getItem(SIDE_KEY)); return v > 0 ? v : undefined; } catch { return undefined; } })();
const saveSide = (w: number | null) => { try { if (w) localStorage.setItem(SIDE_KEY, String(w)); else localStorage.removeItem(SIDE_KEY); } catch { /* приватный режим */ } };

export function App() {
  const boot = useGlobal((s) => s.boot);
  const openChatId = useGlobal((s) => s.openChatId);
  const view = useGlobal((s) => s.sidebarView);
  const infoOpen = useGlobal((s) => s.infoOpen);
  const { wp } = useWallpaper();
  if (boot === 'loading') return null;
  if (boot === 'login') return <Login />;
  return (
    <>
      <FloatShell class={openChatId ? 'app-chat-open' : ''} pattern={wp.pattern} wallpaperColors={wp.colors} wallpaperBlur={wp.blur} sideWidth={savedSide} onSideResize={saveSide} aside={<AsidePanel open={infoOpen && !!openChatId} label="Информация"><Info /></AsidePanel>} sidebar={<SideFrame><SlideStack order={orderFor(view)} active={view} render={(k: string) => (k === 'chats' ? <Sidebar /> : k === 'settings' ? <Main /> : k === 'settings/profile' ? <Profile /> : k === 'settings/general' ? <General /> : k === 'settings/general/wallpaper' ? <Wallpaper /> : k === 'contacts' ? <Contacts /> : /^contacts\/\d+\/edit$/.test(k) ? <EditContact key={k} path={k} active={k === view} /> : LEGACY[k] ? <LegacyPage path={k} title={LEGACY[k]} /> : <Placeholder path={k} />)} /></SideFrame>}>
        {openChatId ? (
          <Chat key={openChatId} chatId={openChatId} />
        ) : (
          <div class="app-empty-main">
            <EmptyState title="Выберите чат" text="Переписка хранится на устройстве и доступна даже без сети." />
          </div>
        )}
      </FloatShell>
      <NewChat />
      <NewContact />
      <AppToast />
    </>
  );
}

/** Общий тост (ошибки сохранения настроек): живёт над всем приложением, уходит плавно. */
function AppToast() {
  const toast = useGlobal((s) => s.toast);
  const last = useRef('');
  if (toast) last.current = toast.text;
  return (
    <Presence show={!!toast} exitMs={200}>
      <div class="app-toast app-toast-global"><Toast>{toast?.text ?? last.current}</Toast></div>
    </Presence>
  );
}
