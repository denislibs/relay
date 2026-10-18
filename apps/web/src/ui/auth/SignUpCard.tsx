import { Avatar, Button, TextField } from '@relay/ui';
import { useRef, useState } from 'preact/hooks';
import { call, errorText, type Step } from './api';
import { CardHead, type Card, ErrorLine, Spinner, useFlow } from './AuthFlow';

/** Регистрация нового номера: заголовок — живое превью имени, аватар с инициалами. */
export function SignUpCard(props: { card: Extract<Card, { name: 'signup' }> }) {
  const flow = useFlow();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = [first.trim(), last.trim()].filter(Boolean).join(' ');
  const v = useRef({ first: '', last: '' }).current;   // Enter сразу после ввода — значения отсюда

  async function submit(e: Event) {
    e.preventDefault();
    if (busy) return;
    if (!v.first.trim()) { setMissing(true); return; }
    setBusy(true);
    setError(null);
    const r = await call<Step>('/auth/signup', { pendingId: props.card.pendingId, firstName: v.first, lastName: v.last });
    if (r.ok) { flow.finish(r.data); return; }
    setBusy(false);
    if (r.code === 'code_expired') { flow.go({ name: 'phone', phone: props.card.phone }); return; }
    setError(errorText(r.code));
  }

  return (
    <form class="auth-form" onSubmit={submit} noValidate>
      <CardHead
        art={<Avatar name={name || '?'} size={120} />}
        title={<span class={name ? '' : 'auth-placeholder'}>{name || 'Ваше имя'}</span>}
        text={'Введите имя — его увидят\nваши собеседники.'}
      />
      <div class="auth-fields">
        <TextField label="Имя (обязательно)" value={first} maxLength={70} autoFocus error={missing ? 'Введите имя' : undefined} onInput={(x: string) => { v.first = x; setFirst(x); setMissing(false); }} />
        <TextField label="Фамилия (необязательно)" value={last} maxLength={64} onInput={(x: string) => { v.last = x; setLast(x); }} />
        <ErrorLine text={error} />
        <Button type="submit" size="lg" class="auth-submit" disabled={busy}>{busy ? <>Подождите…<Spinner /></> : 'Начать общение'}</Button>
      </div>
    </form>
  );
}
