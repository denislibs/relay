import { GROUP_CALL_TITLE_MAX, type GroupCallPlan } from '@relay/protocol';
import { Button, DatePicker, Modal, TextField } from '@relay/ui';
import { useState } from 'preact/hooks';
import { cancelPlan, planCall } from '../../calls/callPlans';
import { clockOf, nextSlot, whenText, withClock } from '../../schedule';
import { showToast } from '../../settingsData';

const MAX_MS = 30 * 24 * 3600_000;   // как на сервере (domain/groupCalls.ts)

/** «Запланировать звонок» (админ группы с правом calls): название и время; план есть — перенести или отменить. */
export function CallPlanModal({ chatId, plan, onClose }: { chatId: number; plan: GroupCallPlan | null; onClose: () => void }) {
  const now = Date.now();
  const [at, setAt] = useState(() => plan?.at ?? nextSlot(now));
  const [title, setTitle] = useState(plan?.title ?? '');
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const err = at < Date.now() + 60_000 ? 'Это время уже прошло' : at > Date.now() + MAX_MS ? 'Можно запланировать не больше чем на 30 дней вперёд' : null;
  const submit = async () => {
    if (err || busy) return;
    setBusy(true);
    try { await planCall(chatId, at, title); showToast('Звонок запланирован на ' + whenText(at, Date.now())); onClose(); }
    catch { showToast('Не удалось запланировать звонок'); setBusy(false); }
  };
  const drop = async () => {
    setBusy(true);
    try { await cancelPlan(chatId); showToast('Запланированный звонок отменён'); onClose(); }
    catch { showToast('Не удалось отменить'); setBusy(false); }
  };
  return (
    <Modal open size="slim" class="rl-dm app-callplan-modal" title={plan ? 'Запланированный звонок' : 'Запланировать звонок'} onClose={onClose}
      actions={[
        ...(plan ? [<Button key="c" variant="danger" disabled={busy} onClick={() => void drop()}>Отменить звонок</Button>] : []),
        <Button key="s" variant="primary" disabled={!!err || busy} onClick={() => void submit()}>{plan ? 'Сохранить' : 'Запланировать'}</Button>,
      ]}>
      <div onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as Element).nodeName !== 'BUTTON') { e.preventDefault(); void submit(); } }}>
        <TextField label="Название (необязательно)" value={title} maxLength={GROUP_CALL_TITLE_MAX} onInput={(v: string) => setTitle(v)} />
        <div class="rl-todo-sec">Когда</div>
        <button type="button" class="rl-dm-preview" onClick={() => setPicking(true)}>{whenText(at, now)}</button>
        <div class="rl-dm-time">
          <span>Время</span>
          <input type="time" class="rl-dm-timein" aria-label="Время" value={clockOf(at)} onInput={(e) => { const v = (e.currentTarget as HTMLInputElement).value; if (v) setAt(withClock(new Date(at), v)); }} />
        </div>
        {err ? <div class="app-sched-err" role="alert">{err}</div> : null}
        <p class="app-callplan-note">Участники увидят плашку над чатом и смогут включить напоминание. Звонок начнёт администратор.</p>
      </div>
      {picking ? (
        <DatePicker open value={new Date(at)} min={new Date(now)} max={new Date(now + MAX_MS)} title="Выбрать"
          onPick={(day: Date) => { setAt(withClock(day, clockOf(at))); setPicking(false); }} onClose={() => setPicking(false)} />
      ) : null}
    </Modal>
  );
}
