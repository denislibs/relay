import { Button, Modal, Presence } from '@relay/ui';
import { useState } from 'preact/hooks';
import { startDirectChat } from '../data';
import { setGlobal, useGlobal } from '../global';

/** Dev: новый личный чат по id пользователя (поиск по контактам — следующий этап). */
export function NewChat() {
  const open = useGlobal((s) => s.newChatOpen);
  const me = useGlobal((s) => s.me);
  const [peer, setPeer] = useState('');
  const [error, setError] = useState('');
  const close = () => { setGlobal({ newChatOpen: false }); setPeer(''); setError(''); };
  async function create(e?: Event) {
    e?.preventDefault();
    const id = Number(peer);
    if (!id || id === me?.userId) { setError('Введите id другого пользователя'); return; }
    try { await startDirectChat(id); close(); } catch (err) { setError((err as Error).message); }
  }
  return (
    <Presence show={open}>
      <div style={{ position: 'fixed', inset: 0, zIndex: 20 }}>
        <Modal title="Новый чат" icon="chats" onClose={close} actions={[
          <Button key="c" variant="secondary" onClick={close}>Отмена</Button>,
          <Button key="o" onClick={() => create()}>Начать</Button>,
        ]}>
          <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0, color: 'var(--ink-muted)', textAlign: 'center' }}>Ваш id: <b>{me?.userId}</b>. Введите id собеседника.</p>
            <label for="peer-id" class="rl-sr">Id собеседника</label>
            <input id="peer-id" class="app-field" inputMode="numeric" value={peer} onInput={(e) => setPeer((e.target as HTMLInputElement).value)} placeholder="Например, 2" autofocus />
            {error ? <p role="alert" style={{ margin: 0, color: 'var(--danger)', textAlign: 'center' }}>{error}</p> : null}
          </form>
        </Modal>
      </div>
    </Presence>
  );
}
