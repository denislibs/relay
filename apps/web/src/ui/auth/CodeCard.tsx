import { Icon, Owl } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { call, errorText, type Step } from './api';
import { CardHead, type Card, ErrorLine, useFlow } from './AuthFlow';
import { CodeInput } from './CodeInput';
import { formatPhone } from './phone';

const RESEND_SEC = 60;

/** Код: сова следит за клетками, автоотправка, «изменить номер», повторная отправка через минуту. */
export function CodeCard(props: { card: Extract<Card, { name: 'code' }> }) {
  const flow = useFlow();
  const { card } = props;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [left, setLeft] = useState(() => Math.max(0, RESEND_SEC - Math.floor((Date.now() - card.sentAt) / 1000)));
  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  async function submit(v: string) {
    setBusy(true);
    setError(null);
    const r = await call<Step>('/auth/signin', { attemptId: card.attemptId, code: v });
    if (r.ok) { flow.finish(r.data, { phone: card.phone }); return; }
    setBusy(false);
    setCode('');
    setError(errorText(r.code));
  }

  async function resend() {
    setResending(true);
    const r = await call<{ attemptId: string; via: 'app' | 'none'; length: number; devCode?: string }>('/auth/code', { login: card.phone });
    setResending(false);
    if (!r.ok) { setError(errorText(r.code)); return; }
    // тот же экран, новый код: без перехода карточек
    flow.go({ ...card, ...r.data, sentAt: Date.now() }, { instant: true });
  }

  // сова: фокус — смотрит на следующую клетку; нет фокуса или идёт проверка — отдыхает
  const tracking = focused && !busy;
  const gaze = Math.min(1, code.length / Math.max(1, card.length - 1));
  const text = card.via === 'app'
    ? 'Мы отправили код в чат «Relay» на устройствах, где вы уже вошли.'
    : 'Сейчас вы нигде не вошли, поэтому код некуда отправить. Войдите по QR-коду или с паскеем.';

  return (
    <div class="auth-form">
      <CardHead
        art={<Owl mode={tracking ? 'track' : 'idle'} gaze={gaze} size={130} />}
        title={
          <span class="auth-phone-title">
            {formatPhone(card.phone, null).value}
            <button type="button" class="auth-edit" aria-label="Изменить номер" onClick={() => flow.go({ name: 'phone', phone: card.phone })}>
              <Icon name="pencil" size={22} />
            </button>
          </span>
        }
        text={text}
      />
      <div class="auth-fields">
        <CodeInput
          length={card.length} value={code} onChange={(v) => { setCode(v); if (error) setError(null); }} onFill={submit}
          error={!!error} disabled={busy} autoFocus label="Код из сообщения" describedBy="auth-code-err" onFocusChange={setFocused}
        />
        <ErrorLine text={error} id="auth-code-err" />
        {card.devCode ? (
          <button type="button" class="auth-devcode" onClick={() => { setCode(card.devCode!); void submit(card.devCode!); }}>
            Код для разработки: <b>{card.devCode}</b>
          </button>
        ) : null}
      </div>
      <div class="auth-links">
        {resending ? <span class="auth-note">Запрашиваем новый код…</span>
          : left > 0 ? <span class="auth-note">Запросить код повторно можно через {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
          : <button type="button" class="auth-link" onClick={resend}>Отправить код ещё раз</button>}
        <button type="button" class="auth-link" onClick={() => flow.go({ name: 'qr' })}>Вход по QR-коду ›</button>
      </div>
    </div>
  );
}
