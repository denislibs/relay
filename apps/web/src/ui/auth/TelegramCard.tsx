import { useEffect, useRef, useState } from 'preact/hooks';
import { call, errorText, type Step } from './api';
import { CardHead, ErrorLine, Logo, useFlow } from './AuthFlow';

const POLL_MS = 2000;

/**
 * «Войти через Telegram»: одноразовая ссылка на бота (живёт 5 минут), бот подтверждает номер контактом или кнопкой
 * «Войти как …». Пока ждём — опрос раз в 2 с; подтверждённый номер дальше идёт как после кода (пароль, регистрация).
 * Ссылка открывается кнопкой, а не сама: всплывающее окно браузер бы заблокировал, а человек сначала видит, что
 * Telegram узнает о Relay (вход необязательный — рядом вход по номеру).
 */
export function TelegramCard() {
  const flow = useFlow();
  const [link, setLink] = useState<{ token: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const alive = useRef(true);
  const current = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function fresh() {
      const r = await call<{ token: string; url: string }>('/auth/telegram', {});
      if (!alive.current) return;
      if (!r.ok) { setError(errorText(r.code)); if (r.code !== 'flood') timer = setTimeout(fresh, 5000); return; }
      current.current = r.data.token;
      setLink(r.data);
      setOpened(false);
      timer = setTimeout(poll, POLL_MS);
    }
    async function poll() {
      const r = await call<(Step & { phone?: string }) | { status: 'wait' | 'denied' | 'expired' }>('/auth/telegram/poll', { token: current.current });
      if (!alive.current) return;
      if (!r.ok) { timer = setTimeout(poll, POLL_MS * 2); return; }
      if ('status' in r.data) {
        if (r.data.status === 'wait') { timer = setTimeout(poll, POLL_MS); return; }
        // отменили в боте или срок вышел — новая ссылка, открыть её нужно снова
        setError(r.data.status === 'denied' ? 'Вход отменён в Telegram' : 'Ссылка устарела — откройте Telegram ещё раз');
        void fresh();
        return;
      }
      flow.finish(r.data, { phone: r.data.phone });
    }
    void fresh();
    return () => { alive.current = false; clearTimeout(timer); };
  }, []);

  return (
    <div class="auth-form">
      <CardHead art={<Logo />} title="Вход через Telegram" text="Бот Relay в Telegram подтвердит ваш номер телефона" />
      <ol class="auth-steps">
        <li><span>Нажмите <b>Открыть Telegram</b> и запустите бота</span></li>
        <li><span>Поделитесь номером кнопкой в боте — или подтвердите вход, если уже входили так</span></li>
        <li><span>Вернитесь сюда: вход продолжится сам</span></li>
      </ol>
      <div class="auth-fields">
        <ErrorLine text={error} />
        <a
          class={'rl-btn rl-btn-primary rl-btn-lg auth-submit auth-tg-open' + (link ? '' : ' auth-tg-wait')}
          href={link?.url} target="_blank" rel="noopener noreferrer" aria-disabled={link ? undefined : 'true'}
          onClick={(e) => { if (!link) { e.preventDefault(); return; } setOpened(true); setError(null); }}
        >
          {opened ? 'Открыть Telegram ещё раз' : 'Открыть Telegram'}
        </a>
      </div>
      {opened ? <p class="auth-note" role="status">Ждём подтверждения в Telegram…</p> : null}
      <p class="auth-note">Telegram узнает, что вы пользуетесь Relay. Не хотите — войдите по номеру телефона.</p>
      <div class="auth-links">
        <button type="button" class="auth-link" onClick={() => flow.go({ name: 'phone' })}>Вход по номеру телефона ›</button>
        <button type="button" class="auth-link" onClick={() => flow.go({ name: 'qr' })}>Вход по QR-коду ›</button>
      </div>
    </div>
  );
}

/** Ссылка на этот способ в других карточках: только если сервер его включил (/auth/config). */
export function TelegramLink() {
  const flow = useFlow();
  if (!flow.telegram) return null;
  return <button type="button" class="auth-link" onClick={() => flow.go({ name: 'telegram' })}>Войти через Telegram ›</button>;
}
