import { Avatar, Button, cropAvatar, Icon, TextField } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { setProfilePhoto } from '../../profilePhoto';
import { call, errorText, type Step } from './api';
import { CardHead, type Card, ErrorLine, Spinner, useFlow } from './AuthFlow';

/**
 * Регистрация нового номера: заголовок — живое превью имени, аватар с инициалами.
 * Пришли через Telegram — имя, фамилия и фото уже подставлены (подсказка: всё можно поменять, фото — убрать).
 */
export function SignUpCard(props: { card: Extract<Card, { name: 'signup' }> }) {
  const flow = useFlow();
  const pre = props.card.prefill;
  const [first, setFirst] = useState(pre?.firstName ?? '');
  const [last, setLast] = useState(pre?.lastName ?? '');
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photo = useTelegramPhoto(pre?.photo ? props.card.pendingId : null);
  const name = [first.trim(), last.trim()].filter(Boolean).join(' ');
  const v = useRef({ first: pre?.firstName ?? '', last: pre?.lastName ?? '' }).current;   // Enter сразу после ввода — значения отсюда

  async function submit(e: Event) {
    e.preventDefault();
    if (busy) return;
    if (!v.first.trim()) { setMissing(true); return; }
    setBusy(true);
    setError(null);
    const r = await call<Step>('/auth/signup', { pendingId: props.card.pendingId, firstName: v.first, lastName: v.last });
    if (r.ok) {
      // сеанс уже есть: фото ставим обычной загрузкой, пока приложение стартует; не вышло — останутся инициалы
      if (photo.blob) void applyPhoto(photo.blob).catch((x) => console.warn('signup photo:', String(x)));
      flow.finish(r.data);
      return;
    }
    setBusy(false);
    if (r.code === 'code_expired') { flow.go({ name: 'phone', phone: props.card.phone }); return; }
    setError(errorText(r.code, r.retryAfter));
  }

  const art = (
    <span class="auth-photo">
      <Avatar name={name || '?'} size={120} src={photo.src ?? undefined} />
      {photo.src ? (
        <button type="button" class="auth-photo-x" aria-label="Убрать фото" title="Убрать фото" onClick={photo.drop}>
          <Icon name="close" size={18} />
        </button>
      ) : null}
    </span>
  );
  return (
    <form class="auth-form" onSubmit={submit} noValidate>
      <CardHead
        art={art}
        title={<span class={name ? '' : 'auth-placeholder'}>{name || 'Ваше имя'}</span>}
        text={pre ? 'Имя и фото — из Telegram.\nИх можно поменять.' : 'Введите имя — его увидят\nваши собеседники.'}
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

/** Фото из Telegram по заявке регистрации. Не пришло — пусто (инициалы), без ошибок: это только подсказка. */
function useTelegramPhoto(pendingId: string | null): { src: string | null; blob: Blob | null; drop(): void } {
  const [p, setP] = useState<{ src: string; blob: Blob } | null>(null);
  useEffect(() => {
    if (!pendingId) return;
    let alive = true, url: string | null = null;
    void fetch('/auth/signup/photo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pendingId }) })
      .then(async (r) => {
        if (!r.ok || !/^image\//.test(r.headers.get('content-type') ?? '')) return;
        const blob = await r.blob();
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setP({ src: url, blob });
      })
      .catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [pendingId]);
  return { src: p?.src ?? null, blob: p?.blob ?? null, drop: () => setP(null) };
}

/** Квадрат по центру → 640/160/превью, как после обрезки в настройках, → фото профиля. */
async function applyPhoto(blob: Blob): Promise<void> {
  const img = await createImageBitmap(blob);
  const side = Math.min(img.width, img.height);
  const c = await cropAvatar(img, (img.width - side) / 2, (img.height - side) / 2, side);
  img.close();
  await setProfilePhoto(c);
}
