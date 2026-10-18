import { Button, Modal } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { acceptQr, qrInfo } from '../authSettings';
import { showToast } from '../settingsData';

/**
 * Подтверждение входа по QR на вошедшем устройстве. Токен приходит двумя путями:
 * ссылка «/#qr=<токен>» (камера телефона открыла Relay) или сканер «Подключить устройство».
 */
let openFor: ((token: string) => void) | null = null;
export function confirmQr(token: string): void { openFor?.(token); }

const tokenOf = (text: string) => /[#&]qr=([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? (/^[A-Za-z0-9_-]{43}$/.test(text) ? text : null);

export function QrConfirm() {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<{ device: string | null; ip: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    openFor = (t) => { setToken(t); setInfo(null); setError(null); };
    const t = tokenOf(location.hash);
    if (t) {
      history.replaceState(null, '', location.pathname + location.search);   // токен не остаётся в адресе
      openFor(t);
    }
    return () => { openFor = null; };
  }, []);

  useEffect(() => {
    if (!token) return;
    void qrInfo(token).then((r) => {
      if (r.ok) setInfo(r.data);
      else setError(r.code === 'qr_expired' ? 'Код устарел. Обновите QR-код на новом устройстве и отсканируйте снова.' : 'Не удалось проверить код');
    });
  }, [token]);

  if (!token) return null;
  const close = () => setToken(null);
  async function accept() {
    setBusy(true);
    const r = await acceptQr(token!);
    setBusy(false);
    if (r.ok) { showToast('Вход подтверждён'); close(); return; }
    setError(r.code === 'fresh_session' ? 'С этого устройства вы вошли недавно по коду — подтвердите вход с другого устройства.' : r.code === 'qr_expired' ? 'Код устарел — отсканируйте новый.' : 'Не удалось подтвердить вход');
  }

  return (
    <Modal title="Войти на новом устройстве?" size="slim" icon="devices" onClose={close} actions={error ? <Button onClick={close}>Понятно</Button> : (
      <><Button variant="ghost" onClick={close}>Отмена</Button><Button disabled={!info || busy} onClick={accept}>{busy ? 'Подтверждаем…' : 'Войти'}</Button></>
    )}>
      {error ? <p class="app-qr-text">{error}</p> : (
        <p class="app-qr-text">
          {info ? <>Кто-то входит в ваш аккаунт: <b>{info.device ?? 'браузер'}</b>{info.ip ? <>, IP <b>{info.ip}</b></> : null}. Подтверждайте, только если это вы.</> : 'Проверяем код…'}
        </p>
      )}
    </Modal>
  );
}

/** Сканер QR камерой (BarcodeDetector). Нет поддержки — подсказка открыть код камерой телефона. */
export function QrScanner(props: { onClose(): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector === 'function';

  useEffect(() => {
    if (!supported) return;
    let stream: MediaStream | null = null, stop = false, raf = 0;
    const Detector = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    const detector = new Detector({ formats: ['qr_code'] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stop) return;
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const tick = async () => {
          if (stop) return;
          try {
            const codes = await detector.detect(v);
            const t = codes.map((c) => tokenOf(c.rawValue)).find(Boolean);
            if (t) { props.onClose(); confirmQr(t); return; }
          } catch { /* кадр не готов */ }
          raf = requestAnimationFrame(() => void tick());
        };
        void tick();
      } catch { setError('Нет доступа к камере. Разрешите его в настройках браузера.'); }
    })();
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  return (
    <Modal title="Подключить устройство" size="slim" onClose={props.onClose}>
      {!supported || error ? (
        <p class="app-qr-text">{error ?? 'Этот браузер не умеет сканировать QR. Наведите камеру телефона на код — Relay откроется и спросит, подтвердить ли вход.'}</p>
      ) : (
        <>
          <div class="app-qr-video"><video ref={video} muted playsInline /><span class="app-qr-frame" /></div>
          <p class="app-qr-text">Наведите камеру на QR-код на экране входа нового устройства.</p>
        </>
      )}
    </Modal>
  );
}
