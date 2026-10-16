import { EmptyState, FloatShell } from '@relay/ui';
import { useGlobal } from '../global';
import { Chat } from './Chat';
import { Login } from './Login';
import { NewChat } from './NewChat';
import { Sidebar } from './Sidebar';

export function App() {
  const boot = useGlobal((s) => s.boot);
  const openChatId = useGlobal((s) => s.openChatId);
  if (boot === 'loading') return null;
  if (boot === 'login') return <Login />;
  return (
    <>
      <FloatShell class={openChatId ? 'app-chat-open' : ''} sidebar={<Sidebar />}>
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
