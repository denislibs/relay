import { Modal, PanelHeader, RadioRow, Section, SelectRow, TextField } from '@relay/ui';
import { useState } from 'preact/hooks';
import { AUTO_DELETE_PRESETS, customTerm, TERM_UNITS, termParts, termText, type TermUnit } from '../autoDelete';
import { setChatAutoDelete } from '../data';
import { findChat, useGlobal } from '../global';

/**
 * Страница «Автоудаление» в правой панели: выбор срока сразу уходит операцией движка и виден сразу (значение очереди),
 * другие участники узнают журналом. Свой срок вводится в окне (монтируется только по нажатию).
 */
export function AutoDeletePage({ chatId, onBack }: { chatId: number; onBack: () => void }) {
  const sec = useGlobal((s) => (findChat(s, chatId)?.autoDeleteSec as number | null | undefined) ?? null);
  const [custom, setCustom] = useState(false);
  const preset = sec != null && (AUTO_DELETE_PRESETS as readonly number[]).includes(sec);
  const pick = (v: number | null) => { void setChatAutoDelete(chatId, v); };
  return (
    <div class="rl-sidepage" aria-label="Автоудаление">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Автоудаление" onClose={onBack} />
      <div class="rl-aside-body">
        <Section title="Удалять сообщения" role="radiogroup"
          footer="Срок действует на сообщения, отправленные после включения, у всех участников. Уже отправленные остаются со своим сроком, даже если автоудаление выключить.">
          <RadioRow checked={sec == null} label="Выкл." onClick={() => pick(null)} />
          {AUTO_DELETE_PRESETS.map((v) => <RadioRow key={v} checked={sec === v} label={'Через ' + termText(v).replace(/^1 неделя$/, 'неделю').replace(/^1 (день|месяц)$/, '$1')} onClick={() => pick(v)} />)}
          <RadioRow checked={sec != null && !preset} label="Свой срок" subtitle={sec != null && !preset ? termText(sec) : 'От часа до года'} onClick={() => setCustom(true)} />
        </Section>
      </div>
      {custom ? <CustomTerm sec={sec} onPick={(v) => { setCustom(false); pick(v); }} onClose={() => setCustom(false)} /> : null}
    </div>
  );
}

function CustomTerm({ sec, onPick, onClose }: { sec: number | null; onPick: (sec: number) => void; onClose: () => void }) {
  const parts = termParts(sec);
  const [value, setValue] = useState(parts.value);
  const [unit, setUnit] = useState<TermUnit>(parts.unit);
  const [touched, setTouched] = useState(false);
  const r = customTerm(value, unit);
  const submit = () => { setTouched(true); if (typeof r === 'number') onPick(r); };
  return (
    <Modal open size="slim" title="Свой срок" onClose={onClose}
      actions={[
        <button key="no" type="button" class="rl-mdl-btn" onClick={onClose}>Отмена</button>,
        <button key="ok" type="button" class="rl-mdl-btn" onClick={submit}>Готово</button>,
      ]}>
      <div class="app-autodel-form" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}>
        <TextField label="Срок" value={value} inputMode="numeric" autoFocus onInput={(v: string) => setValue(v)} error={touched && typeof r === 'string' ? r : undefined} />
        <SelectRow label="Единицы" value={unit} options={TERM_UNITS} onChange={(v: TermUnit) => setUnit(v)} />
      </div>
    </Modal>
  );
}
