import { Button } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { call, errorText } from './api';
import { CardHead, ErrorLine, Logo, Spinner, useFlow } from './AuthFlow';
import { PasskeyButton } from './PasskeyButton';
import { countries, formatPhone, guessCountry, searchCountries, type Country } from './phone';

/** Номер телефона: страна (поиск по списку) + номер с маской страны и серым хвостом шаблона. */
export function PhoneCard(props: { initial?: string }) {
  const flow = useFlow();
  const start = props.initial ? formatPhone(props.initial, null) : null;
  const guess = guessCountry();
  const [country, setCountry] = useState<Country | null>(start?.country ?? guess);
  const [phone, setPhone] = useState(() => start ?? formatPhone(guess ? guess.code : '', guess?.iso ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // рендер откладывается до кадра: быстрый ввод + Enter не должен отправить прошлое значение
  const latest = useRef(phone);
  latest.current = phone;

  useEffect(() => {
    // фокус после въезда карточки (только мышь/клавиатура: на телефоне клавиатура не выскакивает сама)
    if (!matchMedia('(pointer: fine)').matches) return;
    const t = setTimeout(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 230);
    return () => clearTimeout(t);
  }, []);

  function onPhone(raw: string) {
    const next = formatPhone(raw, country?.iso ?? null);
    latest.current = next;
    setPhone(next);
    if (next.country && next.country.iso !== country?.iso) setCountry(next.country);   // номер подсказал страну
    setInvalid(false);
    setError(null);
  }

  function pick(c: Country) {
    setCountry(c);
    latest.current = formatPhone(c.code, c.iso);
    setPhone(latest.current);
    setInvalid(false);
    requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }

  async function submit(e?: Event) {
    e?.preventDefault();
    const cur = latest.current;
    if (busy || cur.digits.length < 7) { if (cur.digits.length) setInvalid(true); return; }
    setBusy(true);
    setError(null);
    const login = '+' + cur.digits;
    const r = await call<{ attemptId: string; via: 'app' | 'none'; length: number; devCode?: string }>('/auth/code', { login });
    setBusy(false);
    if (!r.ok) {
      if (r.code === 'bad_frame') setInvalid(true);
      else setError(errorText(r.code));
      return;
    }
    flow.go({ name: 'code', phone: login, ...r.data, sentAt: Date.now() });
  }

  const canSubmit = phone.digits.length > 1;
  return (
    <form class="auth-form" onSubmit={submit} noValidate>
      <CardHead art={<Logo />} title="Вход в Relay" text={'Проверьте код страны\nи введите номер телефона.'} />
      <div class="auth-fields">
        <CountryPicker value={country} onPick={pick} />
        <div class={'rl-tf auth-tf rl-tf-filled' + (invalid ? ' rl-tf-error' : '')}>
          <div class="rl-tf-box">
            <input
              ref={input} id="auth-phone" class="rl-tf-input" type="tel" inputMode="tel" autoComplete="tel" placeholder=" "
              value={phone.value} disabled={busy} aria-invalid={invalid ? 'true' : undefined}
              onInput={(e) => onPhone(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key?.length === 1 && !/[\d+]/.test(e.key) && !e.metaKey && !e.ctrlKey) e.preventDefault(); }}
            />
            <label class="rl-tf-label" for="auth-phone">{invalid ? 'Неверный номер' : 'Номер телефона'}</label>
            <span class="auth-ghost" aria-hidden="true"><span>{phone.value}</span>{phone.ghost}</span>
          </div>
        </div>
        <ErrorLine text={error} />
        <Button type="submit" size="lg" class="auth-submit" disabled={!canSubmit || busy}>
          {busy ? <>Подождите…<Spinner /></> : 'Далее'}
        </Button>
      </div>
      <div class="auth-links">
        <button type="button" class="auth-link" onClick={() => flow.go({ name: 'qr' })}>Вход по QR-коду ›</button>
        <PasskeyButton disabled={busy} />
        {flow.dev ? <button type="button" class="auth-link auth-link-dev" onClick={() => flow.go({ name: 'dev' })}>Dev-вход по имени</button> : null}
      </div>
    </form>
  );
}

/** Страна: поле с подписью; фокус открывает список с поиском по названию, ISO, коду и инициалам. */
function CountryPicker(props: { value: Country | null; onPick(c: Country): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);   // null — показываем выбранную страну
  const [active, setActive] = useState(0);
  const list = open ? searchCountries(query ?? '') : [];
  const listRef = useRef<HTMLDivElement>(null);
  const shown = query ?? (props.value ? props.value.name : '');

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function choose(c: Country) { props.onPick(c); setOpen(false); setQuery(null); }

  return (
    <div class={'auth-country' + (open ? ' auth-country-open' : '')}>
      <div class={'rl-tf auth-tf' + (shown ? ' rl-tf-filled' : '')}>
        <div class="rl-tf-box">
          {props.value && query == null ? <span class="auth-flag" aria-hidden="true">{props.value.flag}</span> : null}
          <input
            id="auth-country" class={'rl-tf-input' + (props.value && query == null ? ' auth-with-flag' : '')} placeholder=" " autoComplete="off"
            role="combobox" aria-expanded={open} aria-controls="auth-country-list" aria-autocomplete="list"
            value={shown}
            onFocus={(e) => { setOpen(true); setActive(0); e.currentTarget.select(); }}
            onBlur={() => setTimeout(() => { setOpen(false); setQuery(null); }, 120)}
            onInput={(e) => { setQuery(e.currentTarget.value); setActive(0); setOpen(true); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); if (list[active]) choose(list[active]); }
              else if (e.key === 'Escape') { setOpen(false); setQuery(null); }
            }}
          />
          <label class="rl-tf-label" for="auth-country">Страна</label>
          <span class="auth-chevron" aria-hidden="true" />
        </div>
      </div>
      {open ? (
        <div class="auth-country-list" id="auth-country-list" role="listbox" ref={listRef}>
          {list.slice(0, countries().length).map((c, i) => (
            <div
              key={c.iso} role="option" aria-selected={i === active} class={'auth-country-row' + (i === active ? ' auth-country-active' : '')}
              onMouseDown={(e) => { e.preventDefault(); choose(c); }} onMouseEnter={() => setActive(i)}
            >
              <span class="auth-country-flag">{c.flag}</span>
              <span class="auth-country-name">{c.name}</span>
              <span class="auth-country-code">+{c.code}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
