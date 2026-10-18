import { Button, Icon, Owl } from '@relay/ui';
import { clientProof } from '@relay/protocol/src/srp';
import { useEffect, useRef, useState } from 'preact/hooks';
import { call, errorText, type Step } from './api';
import { CardHead, type Card, ErrorLine, Spinner, useFlow } from './AuthFlow';
import { CodeInput } from './CodeInput';

/** Облачный пароль: сова закрыла глаза; «показать» — подглядывает. Пароль не уходит на сервер — только SRP-доказательство. */
export function PasswordCard(props: { card: Extract<Card, { name: 'password' }> }) {
  const flow = useFlow();
  const { card } = props;
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { const t = setTimeout(() => input.current?.focus(), 230); return () => clearTimeout(t); }, []);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy) return;
    const password = input.current?.value ?? value;   // не из состояния: рендер мог ещё не случиться
    if (!password) { setWrong(true); return; }
    setBusy(true);
    setError(null);
    const ch = await call<{ srpId: string; salt: string; B: string }>('/auth/password/challenge', { pendingId: card.pendingId });
    if (!ch.ok) return fail(ch.code);
    let proof: { A: string; M1: string };
    try { proof = await clientProof(password, ch.data.salt, ch.data.B); } catch { return fail('internal'); }
    const r = await call<Step>('/auth/password/check', { pendingId: card.pendingId, srpId: ch.data.srpId, ...proof });
    if (r.ok) { flow.finish(r.data); return; }
    fail(r.code);
  }

  function fail(code: string) {
    setBusy(false);
    if (code === 'password_invalid') { setWrong(true); requestAnimationFrame(() => input.current?.select()); return; }
    if (code === 'code_expired') { flow.go({ name: 'phone' }); return; }   // вход устарел — заново
    setError(errorText(code));
  }

  async function forgot() {
    setRecovering(true);
    const r = await call<{ emailPattern: string }>('/auth/password/recover', { pendingId: card.pendingId });
    setRecovering(false);
    if (!r.ok) { setError(errorText(r.code)); return; }
    flow.go({ name: 'recover', pendingId: card.pendingId, hint: card.hint, emailPattern: r.data.emailPattern });
  }

  return (
    <form class="auth-form" onSubmit={submit} noValidate>
      <CardHead art={<Owl mode="cover" peek={show} size={130} />} title="Введите пароль" text={'Аккаунт защищён\nоблачным паролем.'} />
      <div class="auth-fields">
        <div class={'rl-tf auth-tf' + (value ? ' rl-tf-filled' : '') + (wrong ? ' rl-tf-error' : '')}>
          <div class="rl-tf-box">
            <input
              ref={input} id="auth-password" class={'rl-tf-input auth-password' + (show ? '' : ' auth-password-dots')} type={show ? 'text' : 'password'}
              autoComplete="current-password" placeholder=" " value={value} disabled={busy} aria-invalid={wrong ? 'true' : undefined}
              onInput={(e) => { setValue(e.currentTarget.value); setWrong(false); setError(null); }}
            />
            <label class="rl-tf-label" for="auth-password">{card.hint || 'Пароль'}</label>
            <button type="button" class="auth-eye" aria-label={show ? 'Скрыть пароль' : 'Показать пароль'} aria-pressed={show} onClick={() => { setShow(!show); input.current?.focus(); }}>
              <Icon name={show ? 'eyeOff' : 'eye'} size={22} />
            </button>
          </div>
        </div>
        <button type="button" class="auth-link auth-forgot" disabled={recovering} onClick={forgot}>{recovering ? 'Отправляем код…' : 'Забыли пароль?'}</button>
        <ErrorLine text={error} />
        <Button type="submit" size="lg" class="auth-submit" disabled={busy}>
          {busy ? <>Проверяем…<Spinner /></> : wrong ? 'Неверный пароль' : 'Далее'}
        </Button>
      </div>
    </form>
  );
}

/** Восстановление: 6 цифр из письма, автоотправка. Верный код снимает облачный пароль. */
export function RecoverCard(props: { card: Extract<Card, { name: 'recover' }> }) {
  const flow = useFlow();
  const { card } = props;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!flow.dev) return;
    void fetch('/dev/codes').then((r) => r.json()).then((d: { items: { code: string; kind: string }[] }) => setDevCode(d.items.find((i) => i.kind === 'recovery')?.code ?? null)).catch(() => {});
  }, [flow.dev]);

  async function submit(v: string) {
    setBusy(true);
    setError(null);
    const r = await call<Step>('/auth/password/recover/check', { pendingId: card.pendingId, code: v });
    if (r.ok) { flow.finish(r.data); return; }
    setBusy(false);
    setCode('');
    setError(errorText(r.code));
  }

  return (
    <div class="auth-form">
      <CardHead
        art={<Owl mode={focused && !busy ? 'track' : 'idle'} gaze={Math.min(1, code.length / 5)} size={130} />}
        title="Сброс пароля"
        text={<>Введите код, который мы отправили на <b>{card.emailPattern}</b>. Он снимет облачный пароль.</>}
      />
      <div class="auth-fields">
        <CodeInput length={6} value={code} onChange={(v) => { setCode(v); setError(null); }} onFill={submit} error={!!error} disabled={busy} autoFocus label="Код из письма" describedBy="auth-rec-err" onFocusChange={setFocused} />
        <ErrorLine text={error} id="auth-rec-err" />
        {devCode ? <button type="button" class="auth-devcode" onClick={() => { setCode(devCode); void submit(devCode); }}>Код из /dev/codes: <b>{devCode}</b></button> : null}
      </div>
      <div class="auth-links">
        <button type="button" class="auth-link" onClick={() => flow.go({ name: 'password', pendingId: card.pendingId, hint: card.hint })}>Отмена</button>
      </div>
    </div>
  );
}
