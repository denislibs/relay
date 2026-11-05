import { Button, Checkbox, DatePicker, Icon, Modal } from '@relay/ui';
import { useState } from 'preact/hooks';
import { checkSchedule, clockOf, maxScheduleDay, nextSlot, quickOptions, SCHEDULE_ERROR_TEXT, submitLabel, whenText, withClock } from '../schedule';

/** Выбор даты и времени отложенного: быстрые варианты сразу отправляют; своя дата и время — кнопкой внизу. */
export function ScheduleModal({ saved, initial, allowSilent = true, onPick, onClose }: { saved: boolean; initial?: number; allowSilent?: boolean; onPick: (r: { at: number; silent: boolean }) => void; onClose: () => void }) {
  const now = Date.now();
  const [at, setAt] = useState(() => initial ?? nextSlot(now));
  const [picking, setPicking] = useState(false);
  const [silent, setSilent] = useState(false);
  const err = checkSchedule(at, Date.now());
  const submit = () => { if (!checkSchedule(at, Date.now())) onPick({ at, silent }); };
  return (
    <Modal open size="slim" class="rl-dm app-sched-modal" title={saved ? 'Напомнить' : 'Отправить позже'} onClose={onClose}
      actions={[<Button key="s" variant="primary" disabled={!!err} onClick={submit}>{submitLabel(at, Date.now(), saved)}</Button>]}>
      <div onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as Element).nodeName !== 'BUTTON') { e.preventDefault(); submit(); } }}>
        {initial == null ? (
          <div class="app-sched-quick">
            {quickOptions(now).map((o) => (
              <button key={o.at} type="button" class="app-sched-opt" onClick={() => onPick({ at: o.at, silent })}><Icon name="clock" size={20} /><span>{o.label}</span></button>
            ))}
          </div>
        ) : null}
        <div class="rl-todo-sec">Своя дата и время</div>
        <button type="button" class="rl-dm-preview" onClick={() => setPicking(true)}>{whenText(at, now)}</button>
        <div class="rl-dm-time">
          <span>Время</span>
          <input type="time" class="rl-dm-timein" aria-label="Время" value={clockOf(at)} onInput={(e) => { const v = (e.currentTarget as HTMLInputElement).value; if (v) setAt(withClock(new Date(at), v)); }} />
        </div>
        {err ? <div class="app-sched-err" role="alert">{SCHEDULE_ERROR_TEXT[err]}</div> : null}
        {allowSilent ? <div class="rl-dm-week"><Checkbox id="sched-silent" checked={silent} onChange={() => setSilent(!silent)}>{saved ? 'Без уведомления' : 'Без звука'}</Checkbox></div> : null}
      </div>
      {picking ? (
        <DatePicker open value={new Date(at)} min={new Date(now)} max={maxScheduleDay(now)} title="Выбрать"
          onPick={(day: Date) => { setAt(withClock(day, clockOf(at))); setPicking(false); }} onClose={() => setPicking(false)} />
      ) : null}
    </Modal>
  );
}
