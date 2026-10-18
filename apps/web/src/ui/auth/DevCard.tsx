import { Button, TextField } from '@relay/ui';
import { useState } from 'preact/hooks';
import { CardHead, ErrorLine, Logo, useFlow } from './AuthFlow';

/** Dev-вход по имени (DEV_LOGIN=1): сервер создаст пользователя. Для тестов и разработки. */
export function DevCard() {
  const flow = useFlow();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: Event) {
    e.preventDefault();
    if (!name.trim()) return;
    const res = await fetch('/dev/login', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }).catch(() => null);
    if (!res?.ok) { setError('Не удалось войти'); return; }
    const { userId } = await res.json();
    flow.finish({ userId });
  }
  return (
    <form class="auth-form" onSubmit={submit}>
      <CardHead art={<Logo size={96} />} title="Dev-вход" text="Введите имя — сервер создаст пользователя." />
      <div class="auth-fields">
        <TextField label="Имя" value={name} autoFocus onInput={(v: string) => setName(v)} />
        <ErrorLine text={error} />
        <Button type="submit" size="lg" class="auth-submit" disabled={!name.trim()}>Войти</Button>
      </div>
      <div class="auth-links"><button type="button" class="auth-link" onClick={() => flow.go({ name: 'phone' })}>Вход по номеру телефона ›</button></div>
    </form>
  );
}
