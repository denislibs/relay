import { JoinLink } from './group/JoinLink';
import { LinkEdit } from './links/LinkEdit';
import { ForwardPicker } from './ForwardPicker';
import { Links } from './links/Links';
import { FolderColumn, useFolderPlace } from './folderNav';
import { AsidePanel, FloatShell, ModalRoot, Presence, SideFrame, SlideStack, Toast } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { setGlobal, useGlobal } from '../global';
import { orderFor } from '../nav';
import { useWallpaper } from '../wallpapers';
import { useWallpaperImage } from '../wallpaperImage';
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
import { Password } from './settings/Password';
import { Passkeys } from './settings/Passkeys';
import { QrConfirm } from './QrLogin';
import { PeoplePicker } from './settings/PeoplePicker';
import { Privacy } from './settings/Privacy';
import { PrivacyRule } from './settings/PrivacyRule';
import { Profile } from './settings/Profile';
import { Sessions } from './settings/Sessions';
import { Folders } from './settings/Folders';
import { FolderEdit } from './settings/FolderEdit';
import { FolderChats } from './settings/FolderChats';
import { Wallpaper, WallpaperColor } from './settings/Wallpaper';
import { Dev, DevPlate } from './settings/Dev';
import { Contacts } from './contacts/Contacts';
import { Archive } from './Archive';
import { NewGroupMembers, NewGroupName } from './newChat/NewGroup';
import { NewChannelInfo, NewChannelMembers } from './newChat/NewChannel';
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
  const view = useGlobal((s) => s.sidebarView);
  const hasStack = useGlobal((s) => s.chatStack.length > 0);
  const infoOpen = useGlobal((s) => s.infoOpen);
  const listLeaving = useGlobal((s) => s.listLeaving);
  // телефон: какой экран сверху — список, чат или «Информация» (на широком экране атрибут ни на что не влияет)
  const screen = !openChatId || listLeaving ? 'list' : infoOpen ? 'info' : 'chat';
  const { wp, dark, key: wpKey } = useWallpaper();
  const wpImage = useWallpaperImage(wpKey, wp.image);
  const enter = useGlobal((s) => s.enter);
  // вошли: экран входа ещё 320 мс лежит сверху и гаснет, под ним выезжает приложение (как в Telegram Web K)
  const [leaving, setLeaving] = useState(false);
  const prevBoot = useRef(boot);
  if (prevBoot.current === 'login' && boot === 'app' && !leaving) setLeaving(true);
  prevBoot.current = boot;
  useEffect(() => { if (!leaving) return; const t = setTimeout(() => setLeaving(false), 320); return () => clearTimeout(t); }, [leaving]);
  if (boot === 'loading') return null;
  // один и тот же слой входа в обоих состояниях (ключ) — карточка не пересоздаётся, пока гаснет
  const login = boot === 'login' || leaving ? <div key="login" class={'app-login-layer' + (boot === 'app' ? ' is-leaving' : '')}><Login /></div> : null;
  if (boot === 'login') return <>{login}<AppToast key="toast" /></>;   // тост «Сеанс завершён…» переживает уход на вход
  return (
    <>
      <FloatShell key="shell" screen={screen} class={(openChatId ? 'app-chat-open' : '') + (enter ? ' app-enter-' + enter : '')} rail={folderPlace === 'left' ? <FolderColumn /> : null} pattern={wp.pattern} wallpaperColors={wp.colors} wallpaperBlur={wp.blur} wallpaperDark={dark} wallpaperIntensity={wp.intensity} wallpaperImage={wpImage} sideWidth={savedSide} onSideResize={saveSide} aside={<AsidePanel open={infoOpen && !!openChatId} onClose={() => setGlobal({ infoOpen: false })} label="Информация"><Info /></AsidePanel>} sidebar={<SideFrame><SlideStack order={orderFor(view)} active={view} render={(k: string) => (k === 'chats' ? <Sidebar /> : k === 'settings' ? <Main /> : k === 'settings/profile' ? <Profile /> : k === 'settings/profile/links' ? <Links /> : /^settings\/profile\/links\/(new|\d+)$/.test(k) ? <LinkEdit key={k} path={k} /> : k === 'settings/general' ? <General /> : k === 'settings/general/wallpaper' ? <Wallpaper /> : k === 'settings/general/wallpaper/color' ? <WallpaperColor /> : k === 'settings/notifications' ? <Notifications /> : k === 'settings/privacy' ? <Privacy /> : k === 'settings/privacy/blocked' ? <Blocked /> : k === 'settings/privacy/password' ? <Password /> : k === 'settings/privacy/passkeys' ? <Passkeys /> : /^settings\/privacy\/rule\/[^/]+\/(allow|deny)$/.test(k) ? <PeoplePicker key={k} path={k} /> : /^settings\/privacy\/rule\/[^/]+$/.test(k) ? <PrivacyRule key={k} path={k} /> : k === 'archive' ? <Archive /> : k === 'contacts' ? <Contacts /> : k === 'newGroup' ? <NewGroupMembers /> : k === 'newGroup/name' ? <NewGroupName /> : k === 'newChannel' ? <NewChannelInfo /> : k === 'newChannel/members' ? <NewChannelMembers /> : /^contacts\/\d+\/edit$/.test(k) ? <EditContact key={k} path={k} active={k === view} /> : k === 'settings/performance' ? <Performance /> : k === 'settings/sessions' ? <Sessions /> : k === 'settings/folders' ? <Folders /> : /^settings\/folders\/(new|\d+)$/.test(k) ? <FolderEdit key={k} path={k} /> : /^settings\/folders\/(new|\d+)\/(include|exclude)$/.test(k) ? <FolderChats key={k} path={k} /> : k === 'settings/data' ? <Data /> : /^settings\/data\/autoload\/(photo|video|file)$/.test(k) ? <Autoload path={k} /> : k === 'settings/dev' ? <Dev /> : null)} /></SideFrame>}>
        {hasStack ? <ChatStack /> : null /* чат не выбран — как в Telegram Web, посередине только обои */}
      </FloatShell>
      <NewChat />
      <ModalRoot />
      <ForwardPicker />
      <JoinLink />
      <NewContact />
      <DevPlate />
      <AppToast />
      <QrConfirm />
      {login}
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
