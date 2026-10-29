import { Button, ConfirmDialog, Fab, IconButton, InfoRow, Modal, PanelHeader, Presence, ProfileHeader, Section, SelectField, Sticker, TextField, peerTone } from '@relay/ui';
import { usePhotoPicker } from './usePhotoPicker';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useGlobal, type Me } from '../../global';
import { back, go, setLeaveGuard } from '../../nav';
import { checkUsername, setPersonalChannel, setUsername, showToast, updateProfile } from '../../settingsData';
import { knownPersonalChannels, loadPersonalChannels, useChannelPost } from '../../personalChannel';
import { Expand } from '../Expand';
import { PersonalChannelRow } from '../profile/PersonalChannelBlock';
import { PersonalChannelPicker } from './PersonalChannelPicker';
import type { PersonalChannel } from '@relay/protocol';
import { birthdayText, type Birthday } from '../format';
import {
  BIO_MAX, canSave, channelChanged, clip, cpLen, daysIn, formFromMe, isDirty, NAME_MAX, normUsername, profilePatch, usernameChanged, usernameShapeOk,
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

/** День рождения как в Telegram: торт, «Дата рождения», день · месяц · год в ряд, кто видит — в настройках. */
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
  // пока год набирают, не ругаемся: ошибка — когда введены все 4 цифры или поле покинули
  const [yearLeft, setYearLeft] = useState(false);
  const typed = year.trim().length === 4 || yearLeft;
  const err = !typed ? undefined : yearBad ? 'Неверный год' : future ? 'Ещё впереди' : undefined;
  const incomplete = year.trim().length > 0 && year.trim().length < 4;
  const privacy = () => { onClose(); void go('settings/privacy/rule/birthday'); };
  return (
    <Modal size="slim" onClose={onClose} label="Дата рождения" className="app-bday-modal"
      header={<div class="app-bday-head"><IconButton icon="close" label="Закрыть" onClick={onClose} /></div>}>
      <div class="app-bday">
        <Sticker name="cake" size={150} replay="click" />
        <h2 class="app-bday-title">Дата рождения</h2>
        <div class="app-bday-row">
          <SelectField label="День" value={d} onChange={setDay} options={Array.from({ length: max }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} />
          <SelectField label="Месяц" class="app-bday-month" value={month} onChange={setMonth} options={MONTHS.map((m, i) => ({ value: i + 1, label: m }))} />
          <TextField label="Год" value={year} inputMode="numeric" maxLength={4} error={err} onInput={(v: string) => { setYear(v.replace(/\D/g, '')); setYearLeft(false); }} onBlur={() => setYearLeft(true)} />
        </div>
        <p class="app-bday-note">Кто видит дату рождения — в <button type="button" class="app-bday-link" onClick={privacy}>Настройках ›</button></p>
        {value ? <button type="button" class="app-bday-remove" onClick={() => onSave(null)}>Удалить из профиля</button> : null}
        <Button size="lg" class="app-bday-save" disabled={!!err || incomplete || yearBad || future} onClick={() => onSave(y === undefined ? { day: d, month } : { day: d, month, year: y })}>Сохранить</Button>
      </div>
    </Modal>
  );
}

const NO_CHANNELS = 'Нет подходящих каналов. Подходит публичный канал, которым вы владеете';

/**
 * Карточка «Личный канал» (последняя, как в Telegram): не выбран — оранжевая плитка-мегафон «Добавить канал»; выбран —
 * ячейка канала с последним постом. Смена вида — кроссфейд по высоте (Expand). Клик — выбор; каналов нет — тост.
 */
function PersonalChannelCard({ value, onChange }: { value: PersonalChannel | null; onChange: (c: PersonalChannel | null) => void }) {
  const [list, setList] = useState<PersonalChannel[] | null>(null);
  const post = useChannelPost(value?.id);
  const pick = () => {
    // кандидаты уже предзагружены при входе в «Настройки» — модалка открывается тем же кадром
    const now = knownPersonalChannels();
    if (now) { open(now); return; }
    void loadPersonalChannels().then((l) => { if (l) open(l); else showToast('Нет сети — выбрать канал можно, когда связь вернётся'); });
  };
  const open = (l: PersonalChannel[]) => {
    if (!l.length && !value) { showToast(NO_CHANNELS, 3500); return; }
    setList(l);
    void loadPersonalChannels().then((f) => { if (f) setList((cur) => (cur ? f : cur)); });   // тихо освежить, пока модалка открыта
  };
  return (
    <Section footer="Покажите в профиле канал, которым вы управляете.">
      <Expand show={!value}>{!value ? <InfoRow tile="orange" icon="channels" title="Личный канал" subtitle="Добавить канал" onClick={pick} /> : null}</Expand>
      <Expand show={!!value}>{value ? <PersonalChannelRow channel={value} post={post} onClick={pick} /> : null}</Expand>
      {list ? <PersonalChannelPicker channels={list} current={value} onClose={() => setList(null)} onPick={(c) => { setList(null); onChange(c); }} /> : null}
    </Section>
  );
}

/** «Изменить профиль»: имя, фамилия, о себе, имя пользователя, день рождения, личный канал. Сохраняет ✓, уход с правками — вопрос. */
export function Profile() {
  const me = useGlobal((s) => s.me)!;
  const [form, setForm] = useState<ProfileForm>(() => formFromMe(me));
  const [bday, setBday] = useState(false);
  const [ask, setAsk] = useState<((ok: boolean) => void) | null>(null);
  const status = useUsernameStatus(me, form.username);
  const dirty = isDirty(me, form);
  const ok = canSave(me, form, status);
  const set = (patch: Partial<ProfileForm>) => setForm((f) => ({ ...f, ...patch }));

  const photo = usePhotoPicker(me.photo);
  const [askDelete, setAskDelete] = useState(false);

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
    if (channelChanged(me, form)) jobs.push(setPersonalChannel(form.channel));
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
        <ProfileHeader name={name} tone={peerTone(me.userId)} size={96} {...photo.avatar} />
        {photo.ui}
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
        <Section footer={<>Кто видит дату рождения — в <button type="button" class="app-bday-link" onClick={() => void go('settings/privacy/rule/birthday')}>Настройках ›</button></>}>
          <InfoRow tile="purple" icon="cake" title={form.birthday ? birthdayText(form.birthday) : 'Не указан'} subtitle="День рождения" onClick={() => setBday(true)} />
        </Section>
        <Section>
          <InfoRow tile="blue" icon="link" title="Ссылки" subtitle={linksText(me.links?.length ?? 0)} onClick={() => void go('settings/profile/links')} />
        </Section>
        <Section>
          <InfoRow icon="camera" title={photo.has ? 'Сменить фото' : 'Поставить фото'} onClick={photo.pick} />
          {me.photo && !photo.busy ? <InfoRow icon="trash" danger title="Удалить фото" onClick={() => setAskDelete(true)} /> : null}
        </Section>
        <PersonalChannelCard value={form.channel} onChange={(channel) => set({ channel })} />
      </div>
      <Presence show={dirty && ok} exitMs={200}>
        <div class="rl-fab-slot"><Fab icon="check" label="Сохранить" onClick={save} /></div>
      </Presence>
      <ConfirmDialog open={askDelete} danger title="Удалить фото?" text="Вместо фото снова будут инициалы." confirm="Удалить" cancel="Отмена" onCancel={() => setAskDelete(false)} onConfirm={() => { setAskDelete(false); photo.remove(); }} />
      {bday ? <BirthdayModal value={form.birthday} onClose={() => setBday(false)} onSave={(b) => { set({ birthday: b }); setBday(false); }} /> : null}
      <ConfirmDialog open={!!ask} danger title="Сбросить изменения?" text="Несохранённые изменения профиля пропадут." confirm="Сбросить" cancel="Отмена" onCancel={() => answer(false)} onConfirm={() => answer(true)} />
    </div>
  );
}
