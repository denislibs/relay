import { Button, Card } from '@relay/ui';
import { useState } from 'preact/hooks';

/** Dev-вход по имени (этап 3). Настоящий вход по коду или QR — отдельный этап. */
export function Login() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: Event) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/dev/login', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      if (!res.ok) throw new Error();
      location.reload();
    } catch {
      setError('Не удалось войти. Проверьте, что сервер запущен.');
      setBusy(false);
    }
  }
  return (
    <div class="app-center rl-wallpaper" style={{ background: 'var(--canvas)' }}>
      <Card class="app-login">
        <form class="app-login" onSubmit={submit}>
          <h1>Вход в Relay</h1>
          <p>Режим разработки: введите имя, и сервер создаст пользователя.</p>
          <label for="login-name" class="rl-sr">Имя</label>
          <input id="login-name" class="app-field" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Например, Анна" autocomplete="off" autofocus />
          {error ? <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p> : null}
          <Button type="submit" size="lg" disabled={busy || !name.trim()}>{busy ? 'Входим…' : 'Войти'}</Button>
        </form>
      </Card>
    </div>
  );
}
