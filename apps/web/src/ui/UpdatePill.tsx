import { Icon, Presence, ripple } from '@relay/ui';
import { useState } from 'preact/hooks';
import { useGlobal } from '../global';
import { applyUpdate } from '../update';

/** «Обновить Relay» внизу списка чатов: появляется, когда на сервере новая сборка; клик — новый SW, затем перезагрузка. */
export function UpdatePill() {
  const ready = useGlobal((s) => s.updateReady);
  const [going, setGoing] = useState(false);
  return (
    <Presence show={ready && !going} exitMs={200}>
      <div class="app-update-slot">
        <button type="button" class="app-update" onPointerDown={ripple} onClick={() => { setGoing(true); void applyUpdate(); }}>
          <Icon name="download" size={20} />
          <span>Обновить Relay</span>
        </button>
      </div>
    </Presence>
  );
}
