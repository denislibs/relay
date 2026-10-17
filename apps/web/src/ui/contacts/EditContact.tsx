import { CheckRow, ConfirmDialog, Fab, InfoRow, PanelHeader, Presence, ProfileHeader, Section, TextField } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import { back, setLeaveGuard } from '../../nav';
import { removeContact, showToast, updateContact } from '../../settingsData';
import { toggleMuted } from '../Info';
import { clip, contactDirty, contactPatch, contactValid, cpLen, formFromContact, NAME_MAX, NOTE_MAX, type ContactForm } from './contactsLogic';

/** «Изменить» контакт: имя и фамилия (видны только вам), заметки, уведомления этого чата, «Удалить контакт». */
export function EditContact({ path, active }: { path: string; active: boolean }) {
  const userId = Number(path.split('/')[1]);
  const contact = useGlobal((s) => s.contacts.find((c) => c.userId === userId));
  const loaded = useGlobal((s) => s.contactsLoaded);
  // уйти один раз: после удаления контакт пропадает раньше, чем промис операции вернётся
  const left = useRef(false);
  const leave = () => { if (left.current) return; left.current = true; void back(); };
  // контакт пропал (удалён здесь или на другом устройстве) — страница больше не нужна.
  // Только активная: уходящий слайд SlideStack может смонтироваться заново и ушёл бы назад ещё раз
  useEffect(() => { if (active && loaded && !contact) leave(); }, [active, loaded, !contact]);
  return (
    <div class="rl-sidepage" aria-label="Изменить контакт">
      {contact ? <EditForm contact={contact} leave={leave} /> : <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Изменить контакт" onClose={() => void back()} />}
    </div>
  );
}

function EditForm({ contact, leave }: { contact: Item; leave: () => void }) {
  const userId = contact.userId as number;
  const chat = useGlobal((s) => s.chats.find((c) => c.kind === 'direct' && c.peerId === userId));
  const muted = useGlobal((s) => s.muted);
  const [form, setForm] = useState<ContactForm>(() => formFromContact(contact));
  const [ask, setAsk] = useState<((ok: boolean) => void) | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const dirty = contactDirty(contact, form);
  const ok = contactValid(form);
  const set = (patch: Partial<ContactForm>) => setForm((f) => ({ ...f, ...patch }));

  // контакт поменялся снаружи (другая вкладка/устройство), а здесь правок нет — показываем свежий
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => { if (!dirtyRef.current) setForm(formFromContact(contact)); }, [contact.firstName, contact.lastName, contact.note]);

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
    setLeaveGuard(null);
    void updateContact(userId, contactPatch(contact, form)).then(leave, () => { arm(); showToast('Не удалось сохранить изменения'); });
  }
  function remove(): void {
    setConfirmRemove(false);
    setLeaveGuard(null);
    void removeContact(userId).then(leave, () => showToast('Не удалось сохранить изменения'));
  }

  const limited = (key: keyof ContactForm, max: number) => (v: string, e: Event) => {
    const c = clip(v, max);
    if (c !== v) (e.currentTarget as HTMLInputElement).value = c;
    set({ [key]: c });
  };
  const name = `${form.firstName} ${form.lastName}`.trim() || String(contact.name);
  const publicName = contact.publicName ? String(contact.publicName) : null;
  const chatId = chat?.id as number | undefined;
  const on = chatId == null || !muted.includes(chatId);

  return (
    <>
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Изменить контакт" onClose={() => void back()} />
      <div class="rl-settings app-profile-form">
        <ProfileHeader name={name} size={96} subtitle={publicName && publicName !== name ? `Имя в Relay: ${publicName}` : undefined} />
        <Section footer="Имя и фамилия видны только вам">
          <TextField label="Имя" value={form.firstName} maxLength={NAME_MAX} measure={cpLen} error={form.firstName.trim() ? undefined : 'Укажите имя'} onInput={limited('firstName', NAME_MAX)} autoComplete="off" />
          <TextField label="Фамилия" value={form.lastName} maxLength={NAME_MAX} measure={cpLen} onInput={limited('lastName', NAME_MAX)} autoComplete="off" />
        </Section>
        <Section footer="Заметки видны только вам">
          <TextField label="Заметки" multiline rows={3} counter maxLength={NOTE_MAX} measure={cpLen} value={form.note} onInput={limited('note', NOTE_MAX)} />
        </Section>
        <Section>
          <CheckRow label="Уведомления" subtitle={on ? 'Включены' : 'Выключены'} checked={on} disabled={chatId == null}
            onChange={() => { if (chatId != null) toggleMuted(chatId, muted); }} />
        </Section>
        <Section>
          <InfoRow icon="trash" danger title="Удалить контакт" onClick={() => setConfirmRemove(true)} />
        </Section>
      </div>
      <Presence show={dirty && ok} exitMs={200}>
        <div class="rl-fab-slot"><Fab icon="check" label="Сохранить" onClick={save} /></div>
      </Presence>
      <ConfirmDialog open={!!ask} danger title="Сбросить изменения?" text="Несохранённые изменения контакта пропадут." confirm="Сбросить" cancel="Отмена" onCancel={() => answer(false)} onConfirm={() => answer(true)} />
      <ConfirmDialog open={confirmRemove} danger title="Удалить контакт?" text={`${String(contact.name)} пропадёт из ваших контактов.`} confirm="Удалить" cancel="Отмена" onCancel={() => setConfirmRemove(false)} onConfirm={remove} />
    </>
  );
}
