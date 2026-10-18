import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * Клетки кода: одно невидимое поле поверх ряда клеток (autocomplete one-time-code — браузер подставит код из SMS),
 * активная клетка подсвечена, в следующей пустой мигает курсор; цифра въезжает снизу, удалённая гаснет.
 * Заполнили все клетки — onFill сразу, без кнопки.
 */
export function CodeInput(props: {
  length: number; value: string; onChange(v: string): void; onFill(v: string): void;
  error?: boolean; disabled?: boolean; autoFocus?: boolean; label: string; describedBy?: string;
  onFocusChange?(focused: boolean): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const { length, value } = props;

  useEffect(() => {
    if (!props.autoFocus) return;
    const t = setTimeout(() => ref.current?.focus(), 230);   // после въезда карточки
    return () => clearTimeout(t);
  }, []);
  // после ошибки поле очищают — вернуть фокус
  useEffect(() => { if (!props.disabled && props.autoFocus && value === '' && props.error) ref.current?.focus(); }, [props.error, props.disabled]);

  function input(raw: string) {
    const v = raw.replace(/\D/g, '').slice(0, length);
    props.onChange(v);
    if (v.length === length) props.onFill(v);
  }

  return (
    <div class={'auth-code' + (props.error ? ' auth-code-error' : '') + (props.disabled ? ' auth-code-disabled' : '')} style={{ '--cells': length }}>
      {Array.from({ length }, (_, i) => {
        const ch = value[i];
        const active = focused && (i === value.length || (value.length === length && i === length - 1));
        return (
          <div key={i} class={'auth-cell' + (active ? ' auth-cell-active' : '')}>
            {ch ? <span key={ch + i} class="auth-digit">{ch}</span> : null}
            {active && !ch ? <span class="auth-caret" /> : null}
          </div>
        );
      })}
      <input
        ref={ref} class="auth-code-input" value={value} inputMode="numeric" autoComplete="one-time-code" maxLength={length}
        aria-label={props.label} aria-invalid={props.error ? 'true' : undefined} aria-describedby={props.describedBy}
        disabled={props.disabled}
        onInput={(e) => input(e.currentTarget.value)}
        onFocus={() => { setFocused(true); props.onFocusChange?.(true); }}
        onBlur={() => { setFocused(false); props.onFocusChange?.(false); }}
      />
    </div>
  );
}
