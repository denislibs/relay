import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useEffect, useState } from 'preact/hooks';
import { call, errorText, type Step } from './api';
import { useFlow } from './AuthFlow';

type Options = { id: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] };

/**
 * «Войти с паскеем»: параметры (challenge) берём заранее — кнопка проявляется, когда они готовы.
 * Нет WebAuthn — кнопки нет. После ошибки — новый challenge.
 */
export function PasskeyButton(props: { disabled?: boolean }) {
  const flow = useFlow();
  const [opts, setOpts] = useState<Options | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = browserSupportsWebAuthn();

  async function load() {
    const r = await call<Options>('/auth/passkey/options', {});
    if (r.ok) setOpts(r.data);
  }
  useEffect(() => { if (supported) void load(); }, []);
  if (!supported) return null;

  async function go() {
    if (!opts || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await startAuthentication({ optionsJSON: opts.options });
      const r = await call<Step>('/auth/passkey/finish', { id: opts.id, response });
      if (r.ok) { flow.finish(r.data); return; }
      setError(errorText(r.code));
    } catch {
      // окно браузера закрыли или ключа нет — без тревожного текста
      setError(null);
    }
    setBusy(false);
    setOpts(null);
    void load();
  }

  return (
    <div class={'auth-passkey' + (opts ? ' auth-passkey-ready' : '')}>
      <div>
        <button type="button" class="auth-link" disabled={!opts || busy || props.disabled} onClick={go}>{busy ? 'Ждём паскей…' : 'Войти с паскеем ›'}</button>
        {error ? <span class="auth-note auth-note-error" role="alert">{error}</span> : null}
      </div>
    </div>
  );
}
