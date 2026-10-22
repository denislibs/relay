import { IconButton, Wallpaper } from '@relay/ui';
import { createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { call, signedIn, type Step } from './api';
import { CodeCard } from './CodeCard';
import { DevCard } from './DevCard';
import { PasswordCard, RecoverCard } from './PasswordCard';
import { PhoneCard } from './PhoneCard';
import { QrCard } from './QrCard';
import { SignUpCard } from './SignUpCard';
import { applyTheme } from '../../theme';
import { useWallpaper } from '../../wallpapers';
import { useWallpaperImage } from '../../wallpaperImage';

/**
 * Вход — карточки, сменяющие друг друга (out-in: старая уходит влево и гаснет, новая приходит справа).
 * Текущая карточка живёт в sessionStorage: перезагрузка продолжает вход с того же шага.
 */
export type Card =
  | { name: 'phone'; phone?: string }
  | { name: 'qr' }
  | { name: 'code'; phone: string; attemptId: string; via: 'app' | 'none'; length: number; devCode?: string; sentAt: number }
  | { name: 'password'; pendingId: string; hint: string }
  | { name: 'recover'; pendingId: string; hint: string; emailPattern: string }
  | { name: 'signup'; pendingId: string; phone: string }
  | { name: 'dev' };

type Flow = { go(card: Card, opts?: { instant?: boolean }): void; finish(step: Step, from?: { phone?: string }): void; dev: boolean };
const FlowCtx = createContext<Flow>(null as unknown as Flow);
export const useFlow = () => useContext(FlowCtx);

const KEY = 'relay.auth.card';
const OUT_MS = 180;

function initialCard(): Card {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Card | null;
    if (saved?.name) return saved;
  } catch { /* приватный режим */ }
  // как в Telegram: на компьютере сначала QR, на телефоне — номер
  return matchMedia('(pointer: fine) and (min-width: 700px)').matches ? { name: 'qr' } : { name: 'phone' };
}

export function AuthFlow() {
  const [card, setCard] = useState<Card>(initialCard);
  const [phase, setPhase] = useState<'idle' | 'out' | 'in'>('idle');
  const [leaving, setLeaving] = useState(false);
  const [dev, setDev] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // обои — как в приложении (узор и цвета этого устройства): после входа тот же фон, без смены картинки
  const { wp, dark, key: wpKey } = useWallpaper();
  const wpImage = useWallpaperImage(wpKey, wp.image);

  useEffect(() => { void call<{ dev: boolean }>('/auth/config').then((r) => { if (r.ok) setDev(r.data.dev); }); }, []);
  useEffect(() => { try { sessionStorage.setItem(KEY, JSON.stringify(card)); } catch { /* ok */ } }, [card]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const flow: Flow = {
    dev,
    go(next, opts) {
      clearTimeout(timer.current);
      if (opts?.instant) { setCard(next); return; }
      setPhase('out');
      timer.current = setTimeout(() => { setCard(next); setPhase('in'); }, OUT_MS);
    },
    finish(step, from) {
      if ('passwordNeeded' in step) return flow.go({ name: 'password', pendingId: step.pendingId, hint: step.hint });
      if ('signupRequired' in step) return flow.go({ name: 'signup', pendingId: step.pendingId, phone: from?.phone ?? '' });
      // сеанс выдан: карточка гаснет, затем стартует приложение
      try { sessionStorage.removeItem(KEY); } catch { /* ok */ }
      setLeaving(true);
      timer.current = setTimeout(signedIn, 260);
    },
  };

  return (
    <FlowCtx.Provider value={flow}>
      <div class="auth-bg" aria-hidden="true">
        <Wallpaper pattern={wp.pattern} colors={wp.colors} blur={wp.blur} dark={dark} intensity={wp.intensity} image={wpImage} />
      </div>
      <div class={'auth' + (leaving ? ' auth-leaving' : '')}>
        {/* как в Telegram Web: смена темы прямо на экране входа (новая тема раскрывается кругом из кнопки) */}
        <IconButton class="auth-theme" icon={dark ? 'sun' : 'moon'} label={dark ? 'Светлая тема' : 'Тёмная тема'} onClick={() => applyTheme(dark ? 'light' : 'dark')} />
        <div class="auth-spacer" />
        <div
          key={card.name + ('attemptId' in card ? card.attemptId : '')}
          class={'auth-card' + (phase === 'out' ? ' auth-card-out' : phase === 'in' ? ' auth-card-in' : '')}
          onAnimationEnd={(e) => { if (e.target === e.currentTarget && phase === 'in') setPhase('idle'); }}
        >
          {card.name === 'phone' ? <PhoneCard initial={card.phone} />
            : card.name === 'qr' ? <QrCard />
            : card.name === 'code' ? <CodeCard card={card} />
            : card.name === 'password' ? <PasswordCard card={card} />
            : card.name === 'recover' ? <RecoverCard card={card} />
            : card.name === 'signup' ? <SignUpCard card={card} />
            : <DevCard />}
        </div>
        <div class="auth-spacer" />
      </div>
    </FlowCtx.Provider>
  );
}

/** Заголовок карточки: картинка, h1, подпись. */
export function CardHead(props: { art: preact.ComponentChildren; title: preact.ComponentChildren; text?: preact.ComponentChildren }) {
  return (
    <div class="auth-head">
      <div class="auth-art">{props.art}</div>
      <h1>{props.title}</h1>
      {props.text ? <p>{props.text}</p> : null}
    </div>
  );
}

/** Строка ошибки: не занимает места, пока ошибки нет; появляется плавно, раздвигая карточку. */
export function ErrorLine(props: { text: string | null; id?: string }) {
  const last = useRef(props.text);
  if (props.text) last.current = props.text;
  return (
    <div class={'auth-error' + (props.text ? ' auth-error-on' : '')} id={props.id} role="alert">
      <div><span>{last.current}</span></div>
    </div>
  );
}

/** Логотип Relay: зелёный круг с репликами. */
export function Logo(props: { size?: number }) {
  const s = props.size ?? 120;
  return (
    <svg class="auth-logo" width={s} height={s} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="16" fill="var(--brand)" />
      <path d="M9 12h14M9 17h9" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none" />
    </svg>
  );
}

export function Spinner() {
  return <svg class="auth-spin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /></svg>;
}
