import { Button, ConfirmDialog, InfoRow, Owl, PanelHeader, Section, TextField } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getPassword, removePassword, savePassword, type PasswordState } from '../../authSettings';
import { back } from '../../nav';
import { showToast } from '../../settingsData';

const ERR: Record<string, string> = {
  password_invalid: 'Неверный текущий пароль', email_invalid: 'Проверьте адрес почты', offline: 'Нет соединения', flood: 'Слишком много попыток',
};

/**
 * «Облачный пароль»: второй шаг входа на новых устройствах. Пароль не уходит на сервер — только SRP-верификатор.
 * Сова закрывает глаза, пока вводят пароль, и подглядывает, когда его показывают.
 */
export function Password() {
  const [state, setState] = useState<PasswordState | null>(null);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [hint, setHint] = useState('');
  const [email, setEmail] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askOff, setAskOff] = useState(false);
  // рендер отложен до кадра: Enter сразу после ввода читает значения отсюда, а не из прошлого рендера
  const v = useRef({ current: '', pw: '', pw2: '', hint: '', email: '' }).current;

  useEffect(() => { void getPassword().then((r) => { if (r.ok) setState(r.data); }); }, []);

  function edit() { setMode('edit'); setCurrent(''); setPw(''); setPw2(''); setHint(state?.hint ?? ''); setEmail(''); setError(null); Object.assign(v, { current: '', pw: '', pw2: '', hint: state?.hint ?? '', email: '' }); }

  async function save(e: Event) {
    e.preventDefault();
    if (!v.pw) { setError('Введите новый пароль'); return; }
    if (v.pw !== v.pw2) { setError('Пароли не совпадают'); return; }
    if (v.hint && v.hint.trim() === v.pw) { setError('Подсказка не должна совпадать с паролем'); return; }
    setBusy(true);
    const r = await savePassword({ password: v.pw, hint: v.hint.trim(), email: v.email.trim() }, state?.enabled ? v.current : null);
    setBusy(false);
    if (!r.ok) { setError(ERR[r.code] ?? 'Не удалось сохранить'); return; }
    showToast(state?.enabled ? 'Пароль изменён' : 'Облачный пароль включён');
    setMode('view');
    const s = await getPassword();
    if (s.ok) setState(s.data);
  }

  async function turnOff() {
    setAskOff(false);
    setBusy(true);
    const r = await removePassword(current);
    setBusy(false);
    if (!r.ok) { setCurrent(''); showToast(ERR[r.code] ?? 'Не удалось отключить'); return; }
    showToast('Облачный пароль отключён');
    setState({ enabled: false, hint: '', email: null });
    setMode('view');
  }

  const typing = mode === 'edit';
  return (
    <div class="rl-sidepage" aria-label="Облачный пароль">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Облачный пароль" onClose={() => (typing ? setMode('view') : void back())} />
      <div class="rl-settings">
        <div class="app-pw-head">
          <Owl mode={typing ? 'cover' : 'idle'} peek={show} size={110} />
          <p>{state?.enabled
            ? 'При входе на новом устройстве после кода понадобится этот пароль.'
            : 'Пароль защитит аккаунт, даже если кто-то получит код входа. Его спросят при входе на новом устройстве.'}</p>
        </div>
        {!state ? null : !typing ? (
          <Section>
            {state.enabled ? (
              <>
                <InfoRow tile="green" icon="lock" title="Сменить пароль" subtitle={state.hint ? 'Подсказка: ' + state.hint : undefined} onClick={edit} />
                <InfoRow icon="mail" title="Почта для восстановления" value={state.email ?? 'не задана'} onClick={edit} />
                <InfoRow icon="trash" danger title="Отключить пароль" onClick={() => { setCurrent(''); setAskOff(true); }} />
              </>
            ) : <InfoRow tile="green" icon="lock" title="Установить пароль" onClick={edit} />}
          </Section>
        ) : (
          <form class="app-pw-form" onSubmit={save}>
            <Section footer={state.enabled ? 'Чтобы сменить или отключить пароль, введите текущий.' : 'Пароль хранится только у вас: Relay не сможет его подсказать.'}>
              {state.enabled ? <TextField label="Текущий пароль" type={show ? 'text' : 'password'} value={current} autoFocus onInput={(x: string) => { v.current = x; setCurrent(x); setError(null); }} /> : null}
              <TextField label="Новый пароль" type={show ? 'text' : 'password'} value={pw} autoFocus={!state.enabled} onInput={(x: string) => { v.pw = x; setPw(x); setError(null); }} />
              <TextField label="Повторите пароль" type={show ? 'text' : 'password'} value={pw2} onInput={(x: string) => { v.pw2 = x; setPw2(x); setError(null); }} />
              <label class="app-pw-show"><input type="checkbox" checked={show} onChange={(e) => setShow(e.currentTarget.checked)} /> Показать пароль</label>
            </Section>
            <Section footer="Подсказку видно на экране ввода пароля. Почта нужна, чтобы сбросить пароль, если вы его забудете.">
              <TextField label="Подсказка (необязательно)" value={hint} maxLength={64} onInput={(x: string) => { v.hint = x; setHint(x); }} />
              <TextField label="Почта для восстановления" type="email" value={email} onInput={(x: string) => { v.email = x; setEmail(x); }} hint={state.email ? 'Сейчас: ' + state.email + ' — пустое поле уберёт почту' : undefined} />
            </Section>
            {error ? <p class="app-pw-error" role="alert">{error}</p> : null}
            <div class="app-pw-actions"><Button type="submit" size="lg" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</Button></div>
          </form>
        )}
      </div>
      <ConfirmDialog open={askOff && !!current} danger title="Отключить облачный пароль?" text="Для входа на новом устройстве будет достаточно кода." confirm="Отключить" cancel="Отмена"
        onCancel={() => setAskOff(false)} onConfirm={() => void turnOff()} />
      {askOff && !current ? (
        <OffPrompt onCancel={() => setAskOff(false)} onSubmit={(v) => { setCurrent(v); }} />
      ) : null}
    </div>
  );
}

/** Перед отключением — текущий пароль. */
function OffPrompt(props: { onCancel(): void; onSubmit(v: string): void }) {
  const [v, setV] = useState('');
  return (
    <div class="rl-scrim" onClick={(e) => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <form class="rl-modal" role="dialog" aria-modal="true" aria-label="Текущий пароль" onSubmit={(e) => { e.preventDefault(); if (v) props.onSubmit(v); }}>
        <h2 class="rl-modal-title">Текущий пароль</h2>
        <TextField label="Пароль" type="password" value={v} autoFocus onInput={(x: string) => setV(x)} />
        <div class="rl-modal-actions"><Button variant="ghost" onClick={props.onCancel}>Отмена</Button><Button type="submit" disabled={!v}>Далее</Button></div>
      </form>
    </div>
  );
}
