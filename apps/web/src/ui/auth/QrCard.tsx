import { RelayBadge } from '@relay/ui';
import qrcode from 'qrcode-generator';
import { useEffect, useRef, useState } from 'preact/hooks';
import { call, errorText, type Step } from './api';
import { CardHead, ErrorLine, useFlow } from './AuthFlow';
import { PasskeyButton } from './PasskeyButton';

const POLL_MS = 2000;

/**
 * Вход по QR: в коде ссылка «/#qr=<токен>»; подтверждается вход только сканером в «Настройки → Устройства»
 * (ссылка из камеры телефона лишь открывает этот сканер — WEB-1). Опрашиваем сервер раз в 2 с; токен живёт 30 с.
 */
export function QrCard() {
  const flow = useFlow();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let current: string | null = null;
    let timer: ReturnType<typeof setTimeout>;
    async function fresh() {
      const r = await call<{ token: string }>('/auth/qr', {});
      if (!alive.current) return;
      if (!r.ok) { setError(errorText(r.code)); timer = setTimeout(fresh, 5000); return; }
      setError(null);
      current = r.data.token;
      setToken(current);
      timer = setTimeout(poll, POLL_MS);
    }
    async function poll() {
      const r = await call<Step | { status: 'wait' | 'expired' }>('/auth/qr/poll', { token: current });
      if (!alive.current) return;
      if (!r.ok) { timer = setTimeout(poll, POLL_MS * 2); return; }
      if ('status' in r.data) { timer = r.data.status === 'wait' ? setTimeout(poll, POLL_MS) : setTimeout(fresh, 0); return; }
      flow.finish(r.data);
    }
    void fresh();
    return () => { alive.current = false; clearTimeout(timer); };
  }, []);

  return (
    <div class="auth-form">
      <CardHead
        art={<div class="auth-qr">{token ? <QrImage key={token} text={location.origin + '/#qr=' + token} /> : <span class="auth-qr-wait" />}</div>}
        title="Вход по QR-коду"
        text="Наведите камеру телефона, где вы уже вошли в Relay"
      />
      <ol class="auth-steps">
        <li><span>Откройте Relay на устройстве, где вы уже вошли</span></li>
        <li><span><b>Настройки</b> › <b>Устройства</b> › <b>Подключить устройство</b> — и наведите камеру на код</span></li>
        <li><span>Подтвердите вход</span></li>
      </ol>
      <ErrorLine text={error} />
      <div class="auth-links">
        <button type="button" class="auth-link" onClick={() => flow.go({ name: 'phone' })}>Вход по номеру телефона ›</button>
        <PasskeyButton />
        {flow.dev ? <button type="button" class="auth-link auth-link-dev" onClick={() => flow.go({ name: 'dev' })}>Dev-вход по имени</button> : null}
      </div>
    </div>
  );
}

/** QR в SVG: скруглённые точки, угловые метки — скруглённые рамки, в центре — логотип (уровень коррекции Q). */
function QrImage(props: { text: string }) {
  const qr = qrcode(0, 'Q');
  qr.addData(props.text);
  qr.make();
  const n = qr.getModuleCount();
  const finder = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  const logo = Math.ceil(n * 0.22) | 1, l0 = (n - logo) / 2;
  const underLogo = (r: number, c: number) => r >= l0 - 0.5 && r < l0 + logo + 0.5 && c >= l0 - 0.5 && c < l0 + logo + 0.5;
  const dots: preact.JSX.Element[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c) || finder(r, c) || underLogo(r, c)) continue;
    dots.push(<rect key={r * n + c} x={c + 0.08} y={r + 0.08} width={0.84} height={0.84} rx={0.42} />);
  }
  const corner = (x: number, y: number) => (
    <g key={x + ':' + y}>
      <rect x={x + 0.5} y={y + 0.5} width={6} height={6} rx={2} fill="none" stroke="currentColor" stroke-width={1} />
      <rect x={x + 2} y={y + 2} width={3} height={3} rx={1} />
    </g>
  );
  return (
    <svg class="auth-qr-img" viewBox={`-1 -1 ${n + 2} ${n + 2}`} role="img" aria-label="QR-код для входа">
      <g fill="currentColor">{dots}{corner(0, 0)}{corner(n - 7, 0)}{corner(0, n - 7)}</g>
      <RelayBadge x={l0} y={l0} width={logo} height={logo} />
    </svg>
  );
}
