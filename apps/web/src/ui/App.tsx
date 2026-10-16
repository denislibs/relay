import { EmptyState, FloatShell, SideFrame, SlideStack } from '@relay/ui';
import { useGlobal } from '../global';
import { Chat } from './Chat';
import { Login } from './Login';
import { NewChat } from './NewChat';
import { Settings } from './Settings';
import { Sidebar } from './Sidebar';

// экраны боковой панели от корня вглубь: вперёд — слайд справа налево, назад — обратно
const SIDE_PAGES = ['chats', 'settings'];

export function App() {
  const boot = useGlobal((s) => s.boot);
  const openChatId = useGlobal((s) => s.openChatId);
  const view = useGlobal((s) => s.sidebarView);
  if (boot === 'loading') return null;
  if (boot === 'login') return <Login />;
  return (
    <>
      <FloatShell class={openChatId ? 'app-chat-open' : ''} sidebar={<SideFrame><SlideStack order={SIDE_PAGES} active={view} render={(k: string) => (k === 'settings' ? <Settings /> : <Sidebar />)} /></SideFrame>}>
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
