import { LinkEdit } from './links/LinkEdit';
import { Links } from './links/Links';
import { FolderColumn, useFolderPlace } from './folderNav';
import { AsidePanel, EmptyState, FloatShell, Presence, SideFrame, SlideStack, Toast } from '@relay/ui';
import { useRef } from 'preact/hooks';
import { useGlobal } from '../global';
import { orderFor } from '../nav';
import { useWallpaper } from '../wallpapers';
import { ChatStack } from './ChatStack';
import { Info } from './Info';
import { Login } from './Login';
import { NewChat } from './NewChat';
import { Data } from './settings/Data';
import { Autoload } from './settings/Autoload';
import { Performance } from './settings/Performance';
import { General } from './settings/General';
import { Main } from './settings/Main';
import { Notifications } from './settings/Notifications';
import { Blocked } from './settings/Blocked';
import { PeoplePicker } from './settings/PeoplePicker';
import { Privacy } from './settings/Privacy';
import { PrivacyRule } from './settings/PrivacyRule';
import { Profile } from './settings/Profile';
import { Sessions } from './settings/Sessions';
import { Folders } from './settings/Folders';
import { FolderEdit } from './settings/FolderEdit';
import { FolderChats } from './settings/FolderChats';
import { Wallpaper } from './settings/Wallpaper';
import { Dev, DevPlate } from './settings/Dev';
import { Contacts } from './contacts/Contacts';
import { EditContact } from './contacts/EditContact';
import { NewContact } from './contacts/NewContact';
import { Sidebar } from './Sidebar';



// ширина списка чатов, которую пользователь вытянул за край (null — по умолчанию)
const SIDE_KEY = 'relay.sideWidth';
const savedSide = (() => { try { const v = Number(localStorage.getItem(SIDE_KEY)); return v > 0 ? v : undefined; } catch { return undefined; } })();
const saveSide = (w: number | null) => { try { if (w) localStorage.setItem(SIDE_KEY, String(w)); else localStorage.removeItem(SIDE_KEY); } catch { /* приватный режим */ } };

export function App() {
  const folderPlace = useFolderPlace();
  const boot = useGlobal((s) => s.boot);
  const openChatId = useGlobal((s) => s.openChatId);
  // чат из адреса ещё грузится: середина пустая (только обои), без мелькания «Выберите чат»
  const pendingChatId = useGlobal((s) => s.pendingChatId);
  const view = useGlobal((s) => s.sidebarView);
  const hasStack = useGlobal((s) => s.chatStack.length > 0);
  const infoOpen = useGlobal((s) => s.infoOpen);
  const { wp, dark } = useWallpaper();
  if (boot === 'loading') return null;
  if (boot === 'login') return <><Login /><AppToast /></>;   // тост «Сеанс завершён…» переживает уход на вход
  return (
    <>
      <FloatShell class={openChatId ? 'app-chat-open' : ''} rail={folderPlace === 'left' ? <FolderColumn /> : null} pattern={wp.pattern} wallpaperColors={wp.colors} wallpaperBlur={wp.blur} wallpaperDark={dark} sideWidth={savedSide} onSideResize={saveSide} aside={<AsidePanel open={infoOpen && !!openChatId} label="Информация"><Info /></AsidePanel>} sidebar={<SideFrame><SlideStack order={orderFor(view)} active={view} render={(k: string) => (k === 'chats' ? <Sidebar /> : k === 'settings' ? <Main /> : k === 'settings/profile' ? <Profile /> : k === 'settings/profile/links' ? <Links /> : /^settings\/profile\/links\/(new|\d+)$/.test(k) ? <LinkEdit key={k} path={k} /> : k === 'settings/general' ? <General /> : k === 'settings/general/wallpaper' ? <Wallpaper /> : k === 'settings/notifications' ? <Notifications /> : k === 'settings/privacy' ? <Privacy /> : k === 'settings/privacy/blocked' ? <Blocked /> : /^settings\/privacy\/rule\/[^/]+\/(allow|deny)$/.test(k) ? <PeoplePicker key={k} path={k} /> : /^settings\/privacy\/rule\/[^/]+$/.test(k) ? <PrivacyRule key={k} path={k} /> : k === 'contacts' ? <Contacts /> : /^contacts\/\d+\/edit$/.test(k) ? <EditContact key={k} path={k} active={k === view} /> : k === 'settings/performance' ? <Performance /> : k === 'settings/sessions' ? <Sessions /> : k === 'settings/folders' ? <Folders /> : /^settings\/folders\/(new|\d+)$/.test(k) ? <FolderEdit key={k} path={k} /> : /^settings\/folders\/(new|\d+)\/(include|exclude)$/.test(k) ? <FolderChats key={k} path={k} /> : k === 'settings/data' ? <Data /> : /^settings\/data\/autoload\/(photo|video|file)$/.test(k) ? <Autoload path={k} /> : k === 'settings/dev' ? <Dev /> : null)} /></SideFrame>}>
        {hasStack ? (
          <ChatStack />
        ) : pendingChatId ? null : (
          <div class="app-empty-main">
            <EmptyState title="Выберите чат" text="Переписка хранится на устройстве и доступна даже без сети." />
          </div>
        )}
      </FloatShell>
      <NewChat />
      <NewContact />
      <DevPlate />
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
