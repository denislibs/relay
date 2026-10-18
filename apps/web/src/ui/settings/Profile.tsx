import { Button, ConfirmDialog, Fab, InfoRow, Modal, PanelHeader, Presence, ProfileHeader, Section, SelectRow, TextField, peerTone } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useGlobal, type Me } from '../../global';
import { back, go, setLeaveGuard } from '../../nav';
import { checkUsername, setUsername, showToast, updateProfile } from '../../settingsData';
import { birthdayText, type Birthday } from '../format';
import {
  BIO_MAX, canSave, clip, cpLen, daysIn, formFromMe, isDirty, NAME_MAX, normUsername, profilePatch, usernameChanged, usernameShapeOk,
  USERNAME_TEXT, type ProfileForm, type UsernameStatus,
} from './profileForm';

const CHECK_DELAY = 400;
const linksText = (n: number) => (n === 0 ? 'Добавить GitHub, LinkedIn, соцсети' : n % 10 === 1 && n % 100 !== 11 ? `${n} ссылка` : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? `${n} ссылки` : `${n} ссылок`);
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** Проверка имени пользователя: форма — сразу, занятость — через 400 мс после последней правки. */
function useUsernameStatus(me: Me, value: string): UsernameStatus {
  const [status, setStatus] = useState<UsernameStatus>(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const u = normUsername(value);
    if (!u || u === normUsername(me.username ?? '')) { setStatus(null); return; }
    const shapeOk = usernameShapeOk(u);
    setStatus(shapeOk ? 'checking' : null);
    const t = setTimeout(() => {
      if (!shapeOk) { setStatus('invalid'); return; }
      void checkUsername(u).then((r) => {
        if (n !== seq.current) return;   // пока ждали, имя уже поменяли
        setStatus('offline' in r ? 'offline' : r.ok ? 'free' : r.reason === 'invalid' ? 'invalid' : 'taken');
      });
    }, CHECK_DELAY);
    return () => clearTimeout(t);
  }, [value, me.username]);
  return status;
}

function BirthdayModal({ value, onSave, onClose }: { value: Birthday | null; onSave: (b: Birthday | null) => void; onClose: () => void }) {
  const [day, setDay] = useState(value?.day ?? 1);
  const [month, setMonth] = useState(value?.month ?? 1);
  const [year, setYear] = useState(value?.year ? String(value.year) : '');
  const nowYear = new Date().getFullYear();
  const y = year.trim() ? Number(year) : undefined;
  const yearBad = y !== undefined && (!Number.isInteger(y) || y < 1900 || y > nowYear);
  const future = !yearBad && y !== undefined && new Date(y, month - 1, day).getTime() > Date.now();
  const max = daysIn(month, yearBad ? undefined : y);
  const d = Math.min(day, max);
  const err = yearBad ? `Год от 1900 до ${nowYear}` : future ? 'Эта дата ещё не наступила' : undefined;
  return (
    <Modal title="День рождения" size="slim" onClose={onClose} actions={<>
      {value ? <Button variant="danger" onClick={() => onSave(null)}>Удалить</Button> : null}
      <Button variant="ghost" onClick={onClose}>Отмена</Button>
      <Button disabled={!!err} onClick={() => onSave(y === undefined ? { day: d, month } : { day: d, month, year: y })}>Сохранить</Button>
    </>}>
      <div class="app-bday">
        <SelectRow label="День" value={d} onChange={(v: number) => setDay(Number(v))} options={Array.from({ length: max }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} />
        <SelectRow label="Месяц" value={month} onChange={(v: number) => setMonth(Number(v))} options={MONTHS.map((m, i) => ({ value: i + 1, label: m }))} />
        <TextField label="Год (необязательно)" value={year} inputMode="numeric" maxLength={4} error={err} onInput={(v: string) => setYear(v.replace(/\D/g, ''))} />
      </div>
    </Modal>
  );
}

/** «Изменить профиль»: имя, фамилия, о себе, имя пользователя, день рождения. Сохраняет ✓, уход с правками — вопрос. */
export function Profile() {
  const me = useGlobal((s) => s.me)!;
  const [form, setForm] = useState<ProfileForm>(() => formFromMe(me));
  const [bday, setBday] = useState(false);
  const [ask, setAsk] = useState<((ok: boolean) => void) | null>(null);
  const status = useUsernameStatus(me, form.username);
  const dirty = isDirty(me, form);
  const ok = canSave(me, form, status);
  const set = (patch: Partial<ProfileForm>) => setForm((f) => ({ ...f, ...patch }));

  // профиль поменялся снаружи (другая вкладка/устройство), а здесь правок нет — показываем свежий
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => { if (!dirtyRef.current) setForm(formFromMe(me)); }, [me]);

  // уход с несохранёнными правками: «Сбросить изменения?»
  const arm = () => setLeaveGuard(() => new Promise<boolean>((resolve) => setAsk(() => resolve)));
  useEffect(() => {
    if (!dirty) { setLeaveGuard(null); return; }
    arm();
    return () => setLeaveGuard(null);
  }, [dirty]);
  const answer = (leave: boolean) => { ask?.(leave); setAsk(null); };

  function save(): void {
    if (!dirty || !ok) return;
    const patch = profilePatch(me, form);
    const jobs: Promise<unknown>[] = [];
    if (Object.keys(patch).length) jobs.push(updateProfile(patch));
    if (usernameChanged(me, form)) jobs.push(setUsername(normUsername(form.username) || null));
    setLeaveGuard(null);
    // правки уже в очереди движка (и видны), сервер подтвердит или откатит с тостом
    void Promise.all(jobs).then(() => back(), () => { arm(); showToast('Не удалось сохранить изменения'); });
  }

  const uname = normUsername(form.username);
  const unameErr = status === 'taken' || status === 'invalid' ? USERNAME_TEXT[status] : undefined;
  const unameHint = status === 'checking' || status === 'free' ? USERNAME_TEXT[status] : undefined;
  const link = uname && (!usernameChanged(me, form) || status === 'free' || status === 'offline') ? 'relay/@' + uname : null;
  const copy = (text: string) => { navigator.clipboard?.writeText(text).then(() => showToast('Скопировано')).catch(() => {}); };
  const name = `${form.firstName} ${form.lastName}`.trim() || me.name;
  // длина — в кодовых точках, как на сервере: лишнее срезаем прямо в поле (иначе DOM разойдётся с состоянием)
  const limited = (key: 'firstName' | 'lastName' | 'bio', max: number) => (v: string, e: Event) => {
    const c = clip(v, max);
    if (c !== v) (e.currentTarget as HTMLInputElement).value = c;
    set({ [key]: c });
  };

  return (
    <div class="rl-sidepage" aria-label="Изменить профиль">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Изменить профиль" onClose={() => void back()} />
      <div class="rl-settings app-profile-form">
        <ProfileHeader name={name} tone={peerTone(me.userId)} size={96} />
        <Section>
          <TextField label="Имя" value={form.firstName} maxLength={NAME_MAX} measure={cpLen} error={form.firstName.trim() ? undefined : dirty ? 'Укажите имя' : undefined} onInput={limited('firstName', NAME_MAX)} autoComplete="given-name" />
          <TextField label="Фамилия" value={form.lastName} maxLength={NAME_MAX} measure={cpLen} onInput={limited('lastName', NAME_MAX)} autoComplete="family-name" />
          <TextField label="О себе" multiline rows={3} counter maxLength={BIO_MAX} measure={cpLen} value={form.bio} hint="Можно добавить пару строк о себе…" onInput={limited('bio', BIO_MAX)} />
        </Section>
        <Section title="Имя пользователя">
          <TextField label="Имя пользователя" value={form.username} maxLength={33} error={unameErr} hint={unameHint} class={status === 'free' ? 'app-tf-ok' : undefined} onInput={(v: string) => set({ username: v })} autoComplete="username" />
          {link ? (
            <button type="button" class="app-uname-link" onClick={() => copy(link)} aria-label={'Скопировать ссылку ' + link}>
              <span>Ссылка:</span> <b>{link}</b>
            </button>
          ) : null}
        </Section>
        <Section>
          <InfoRow tile="purple" icon="cake" title={form.birthday ? birthdayText(form.birthday) : 'Не указан'} subtitle="День рождения" onClick={() => setBday(true)} />
          <InfoRow tile="blue" icon="link" title="Ссылки" subtitle={linksText(me.links?.length ?? 0)} onClick={() => void go('settings/profile/links')} />
        </Section>
      </div>
      <Presence show={dirty && ok} exitMs={200}>
        <div class="rl-fab-slot"><Fab icon="check" label="Сохранить" onClick={save} /></div>
      </Presence>
      {bday ? <BirthdayModal value={form.birthday} onClose={() => setBday(false)} onSave={(b) => { set({ birthday: b }); setBday(false); }} /> : null}
      <ConfirmDialog open={!!ask} danger title="Сбросить изменения?" text="Несохранённые изменения профиля пропадут." confirm="Сбросить" cancel="Отмена" onCancel={() => answer(false)} onConfirm={() => answer(true)} />
    </div>
  );
}
