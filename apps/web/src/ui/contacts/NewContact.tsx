import { Avatar, Icon, Modal, Presence, TextField, peerTone } from '@relay/ui';
import { senderAvatar } from '../../profilePhoto';
import { wantPeople } from '../../people';
import { useEffect, useRef, useState } from 'preact/hooks';
import { setGlobal, useGlobal, type NewContactDraft } from '../../global';
import { addContact, resolveUser, showToast } from '../../settingsData';
import { clip, cpLen, initialsOf, NAME_MAX } from './contactsLogic';

const NOT_FOUND = 'Пользователь не найден в Relay';
const close = () => setGlobal({ newContact: null });

/** «Новый контакт»: кого (телефон или @имя) и как назвать. Кружок с инициалами растёт по мере ввода. */
export function NewContact() {
  const draft = useGlobal((s) => s.newContact);
  // форма живёт до конца анимации исчезания; каждое открытие — новая форма
  const last = useRef<NewContactDraft>({});
  const seq = useRef(0);
  const wasOpen = useRef(false);
  if (draft && !wasOpen.current) seq.current++;
  wasOpen.current = !!draft;
  if (draft) last.current = draft;
  return (
    <Presence show={!!draft} exitMs={200}>
      <NewContactForm key={seq.current} draft={last.current} />
    </Presence>
  );
}

function NewContactForm({ draft }: { draft: NewContactDraft }) {
  const [query, setQuery] = useState(draft.query ?? '');
  const [first, setFirst] = useState(draft.firstName ?? '');
  const [lastName, setLast] = useState(draft.lastName ?? '');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  // открыли из «Информации» и запрос не меняли — человек уже известен (поле может быть пустым: нет ни @имени, ни телефона)
  const known = draft.userId && query === (draft.query ?? '') ? draft.userId : null;
  useEffect(() => { if (known) wantPeople([known]); }, [known]);   // аватарка известного человека — из people
  const ready = (!!query.trim() || !!known) && !!first.trim() && !busy;
  const limited = (set: (v: string) => void) => (v: string, e: Event) => {
    const c = clip(v, NAME_MAX);
    if (c !== v) (e.currentTarget as HTMLInputElement).value = c;
    set(c);
  };

  async function done(e?: Event): Promise<void> {
    e?.preventDefault();
    if (!ready) return;
    let userId = known;
    if (!userId) {
      setBusy(true);
      const r = await resolveUser(query.trim());
      if (!live.current) return;
      setBusy(false);
      if ('notFound' in r) { setError(NOT_FOUND); return; }
      if ('offline' in r) { setError('Нет подключения к сети'); return; }
      userId = r.user.id;
    }
    void addContact(userId, first.trim(), lastName.trim()).catch(() => showToast('Не удалось сохранить изменения'));
    close();
  }

  const initials = initialsOf(first, lastName);
  // как диалоги Telegram: заголовок слева, без ✕ (закрывают «Отмена», Esc и щелчок мимо)
  return (
    <Modal title="Новый контакт" closeButton={false} size="confirm" onClose={close} class="app-newcontact-dialog" actions={[
      <button key="no" type="button" class="rl-mdl-btn" onClick={close}>Отмена</button>,
      <button key="ok" type="button" class="rl-mdl-btn" disabled={!ready} onClick={() => void done()}>Готово</button>,
    ]}>
        <form class="app-newcontact" onSubmit={(e) => void done(e)}>
          <div class="app-newcontact-avatar" aria-hidden="true">
            {initials
              ? <span key={initials} class="app-pop"><Avatar name={`${first} ${lastName}`.trim()} tone={known ? peerTone(known) : undefined} size={72} {...(known ? senderAvatar(known) : {})} /></span>
              : <span class="rl-avatar app-newcontact-empty" style={{ width: 72, height: 72 }}><Icon name="contact" size={32} /></span>}
          </div>
          <div class="app-newcontact-fields">
            <TextField label="Телефон или @имя пользователя" value={query} error={error} autoFocus autoComplete="off"
              onInput={(v: string) => { setQuery(v); setError(undefined); }} />
            <TextField label="Имя (обязательно)" value={first} maxLength={NAME_MAX} measure={cpLen} autoComplete="given-name" onInput={limited(setFirst)} />
            <TextField label="Фамилия" value={lastName} maxLength={NAME_MAX} measure={cpLen} autoComplete="family-name" onInput={limited(setLast)} />
          </div>
          <button type="submit" hidden />
        </form>
    </Modal>
  );
}
