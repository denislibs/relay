import type { GeoPoint } from '@relay/protocol';
import { Button, GeoMap, Modal, useMinVisible } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';

type State = { kind: 'locating' } | { kind: 'ready'; at: GeoPoint; accuracy: number } | { kind: 'error'; text: string };

const tileUrl = (z: number, x: number, y: number) => `/maptile/${z}/${x}/${y}.png`;

/**
 * «Отправить геопозицию», как в Telegram: браузер даёт текущие координаты (с разрешения), карта с булавкой —
 * сразу в окне; можно назвать место (тогда это «место»: название и адрес под картой). Лоадер — с задержкой
 * и минимальным временем, без мигания.
 */
export function GeoSend(props: { onSend: (g: GeoPoint) => void; onClose: () => void }) {
  const [st, setSt] = useState<State>({ kind: 'locating' });
  const [title, setTitle] = useState('');
  const [address, setAddress] = useState('');
  const busy = useMinVisible(st.kind === 'locating', { delay: 150, min: 600 });
  useEffect(() => {
    if (!('geolocation' in navigator)) { setSt({ kind: 'error', text: 'Браузер не умеет определять местоположение' }); return; }
    let live = true;
    navigator.geolocation.getCurrentPosition(
      (p) => { if (live) setSt({ kind: 'ready', at: { lat: p.coords.latitude, lng: p.coords.longitude }, accuracy: Math.round(p.coords.accuracy) }); },
      (e) => { if (live) setSt({ kind: 'error', text: e.code === e.PERMISSION_DENIED ? 'Разрешите доступ к геопозиции в настройках браузера' : 'Не удалось определить местоположение' }); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
    return () => { live = false; };
  }, []);
  const send = () => {
    if (st.kind !== 'ready') return;
    const t = title.trim(), a = address.trim();
    props.onSend({ ...st.at, ...(t ? { title: t } : {}), ...(t && a ? { address: a } : {}) });
  };
  return (
    <Modal size="slim" title="Геопозиция" onClose={props.onClose} class="app-geosend" actions={[
      <Button key="c" variant="ghost" onClick={props.onClose}>Отмена</Button>,
      <Button key="s" disabled={st.kind !== 'ready'} onClick={send}>{title.trim() ? 'Отправить место' : 'Отправить'}</Button>,
    ]}>
      <div class="app-geosend-map">
        {st.kind === 'ready' ? <GeoMap geo={st.at} tileUrl={tileUrl} w={320} h={200} /> : null}
        {st.kind === 'locating' && busy ? <span class="app-geosend-note">Определяем местоположение…</span> : null}
        {st.kind === 'error' ? <span class="app-geosend-note app-geosend-err">{st.text}</span> : null}
      </div>
      {st.kind === 'ready' ? <p class="app-geosend-acc">Точность — около {st.accuracy} м</p> : null}
      <input class="rl-todo-input rl-todo-titlein app-geosend-in" placeholder="Название места (необязательно)" maxLength={128} value={title} aria-label="Название места"
        onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
      {title.trim() ? <input class="rl-todo-input rl-todo-titlein app-geosend-in" placeholder="Адрес (необязательно)" maxLength={256} value={address} aria-label="Адрес"
        onInput={(e) => setAddress((e.currentTarget as HTMLInputElement).value)} /> : null}
    </Modal>
  );
}
