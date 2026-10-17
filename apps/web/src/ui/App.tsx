import { AsidePanel, EmptyState, FloatShell, SideFrame, SlideStack } from '@relay/ui';
import { useGlobal } from '../global';
import { orderFor } from '../nav';
import { Chat } from './Chat';
import { Info } from './Info';
import { Login } from './Login';
import { NewChat } from './NewChat';
import { Settings } from './Settings';
import { Placeholder } from './settings/Placeholder';
import { Sidebar } from './Sidebar';


// ширина списка чатов, которую пользователь вытянул за край (null — по умолчанию)
const SIDE_KEY = 'relay.sideWidth';
const savedSide = (() => { try { const v = Number(localStorage.getItem(SIDE_KEY)); return v > 0 ? v : undefined; } catch { return undefined; } })();
const saveSide = (w: number | null) => { try { if (w) localStorage.setItem(SIDE_KEY, String(w)); else localStorage.removeItem(SIDE_KEY); } catch { /* приватный режим */ } };

export function App() {
  const boot = useGlobal((s) => s.boot);
  const openChatId = useGlobal((s) => s.openChatId);
  const view = useGlobal((s) => s.sidebarView);
  const infoOpen = useGlobal((s) => s.infoOpen);
  if (boot === 'loading') return null;
  if (boot === 'login') return <Login />;
  return (
    <>
      <FloatShell class={openChatId ? 'app-chat-open' : ''} sideWidth={savedSide} onSideResize={saveSide} aside={<AsidePanel open={infoOpen && !!openChatId} label="Информация"><Info /></AsidePanel>} sidebar={<SideFrame><SlideStack order={orderFor(view)} active={view} render={(k: string) => (k === 'chats' ? <Sidebar /> : k === 'settings' ? <Settings /> : <Placeholder path={k} />)} /></SideFrame>}>
        {openChatId ? (
          <Chat key={openChatId} chatId={openChatId} />
        ) : (
          <div class="app-empty-main">
            <EmptyState title="Выберите чат" text="Переписка хранится на устройстве и доступна даже без сети." />
          </div>
        )}
      </FloatShell>
      <NewChat />
    </>
  );
}
