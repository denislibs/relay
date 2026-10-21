import { Button, ConfirmDialog, Icon, InfoRow, PanelHeader, Section, Sticker } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { createPasskey, deletePasskey, listPasskeys, passkeysSupported, type Passkey } from '../../authSettings';
import { back } from '../../nav';
import { showToast } from '../../settingsData';
import { fullDateTime } from '../format';

/** «Паскеи»: вход без телефона и кода — Face ID, отпечаток или менеджер паролей. Список, создание, удаление. */
export function Passkeys() {
  const [list, setList] = useState<Passkey[] | null>(null);
  const [max, setMax] = useState(10);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Passkey | null>(null);
  const supported = passkeysSupported();

  useEffect(() => { void listPasskeys().then((r) => { if (r.ok) { setList(r.data.passkeys); setMax(r.data.max); } else setList([]); }); }, []);

  async function create() {
    setBusy(true);
    const r = await createPasskey();
    setBusy(false);
    if (r.ok) { setList(r.data.passkeys); showToast('Паскей создан'); return; }
    if (r.code === 'fresh_session') showToast('С нового входа это можно сделать через сутки или после подтверждения на другом устройстве');
    else if (r.code !== 'cancelled') showToast('Не удалось создать паскей. Попробуйте ещё раз.');
  }

  async function remove(p: Passkey) {
    setAsk(null);
    const r = await deletePasskey(p.id);
    if (r.ok) setList(r.data.passkeys);
    else showToast(r.code === 'fresh_session' ? 'С нового входа это можно сделать через сутки или после подтверждения на другом устройстве' : 'Не удалось удалить паскей');
  }

  return (
    <div class="rl-sidepage" aria-label="Паскеи">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Паскеи" onClose={() => void back()} />
      <div class="rl-settings">
        {list == null ? null : list.length === 0 ? (
          <div class="app-passkey-intro">
            <div class="app-pw-head">
              <Sticker name="key" size={120} replay="click" />
              <h3>Защитите аккаунт</h3>
              <p>Входите без кода: паскей хранится в менеджере паролей и открывается Face ID, отпечатком или паролем устройства.</p>
            </div>
            <Section>
              <InfoRow tile="green" icon="key" title="Создать паскей" subtitle="Займёт пару секунд" />
              <InfoRow tile="blue" icon="lock" title="Вход по биометрии" subtitle="Face ID, Touch ID, Windows Hello или код устройства" />
              <InfoRow tile="purple" icon="shield" title="Надёжное хранение" subtitle="Связка ключей iCloud, Google или ваш менеджер паролей" />
            </Section>
            <div class="app-pw-actions">
              <Button size="lg" disabled={!supported || busy} onClick={create}>{!supported ? 'Браузер не поддерживает паскеи' : busy ? 'Ждём менеджер паролей…' : 'Создать паскей'}</Button>
            </div>
          </div>
        ) : (
          <>
            <Section footer="Паскей хранится в вашем менеджере паролей. Удалённый здесь паскей больше не откроет аккаунт — удалите его и в менеджере.">
              {list.map((p) => (
                <InfoRow key={p.id} tile="green" icon="key" title={p.name}
                  subtitle={'Создан ' + fullDateTime(p.createdAt) + (p.lastUsedAt ? ' · использован ' + fullDateTime(p.lastUsedAt) : '')}
                  onClick={() => setAsk(p)} />
              ))}
              {supported && list.length < max ? <InfoRow icon="plus" title={busy ? 'Ждём менеджер паролей…' : 'Создать паскей'} onClick={busy ? undefined : create} /> : null}
            </Section>
          </>
        )}
      </div>
      <ConfirmDialog open={!!ask} danger title="Удалить паскей?" text={'Паскей «' + (ask?.name ?? '') + '» больше нельзя будет использовать для входа. Удалите его и из менеджера паролей.'}
        confirm="Удалить" cancel="Отмена" onCancel={() => setAsk(null)} onConfirm={() => { if (ask) void remove(ask); }} />
    </div>
  );
}
