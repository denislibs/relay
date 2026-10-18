import { Avatar, IconButton, Presence, peerTone, plural, ripple } from '@relay/ui';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { dismiss, loadDismissed, pickBanner, saveDismissed, type Banner } from '../banners';
import { getGlobal, useGlobal } from '../global';
import { go } from '../nav';
import { setNotify } from '../notify';
import { showToast } from '../settingsData';
import { openDirect } from './contacts/Contacts';

type Contact = { userId: number; name?: string; birthday?: { day: number; month: number } | null };

const TEXT = {
  notify: { title: '🔔 Включите уведомления', text: 'Чтобы не пропускать новые сообщения.' },
  setBirthday: { title: '🎂 Укажите день рождения', text: 'Контакты узнают о нём — смотря кому вы разрешите видеть дату.' },
} as const;

/** Подсказка над вкладками: одна, первая подходящая; раскрывается по высоте и так же сворачивается. */
export function ChatBanner() {
  const notify = useGlobal((s) => s.notify);
  const me = useGlobal((s) => s.me);
  const contacts = useGlobal((s) => s.contacts) as unknown as Contact[];
  const loaded = useGlobal((s) => s.contactsLoaded);
  const [dismissed, setDismissed] = useState(loadDismissed);
  const [day, setDay] = useState(() => new Date().toDateString());
  // полночь: дни рождения сменились — пересчитываем
  useEffect(() => {
    const now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const t = setTimeout(() => setDay(new Date().toDateString()), next.getTime() - now.getTime());
    return () => clearTimeout(t);
  }, [day]);

  const banner = useMemo(() => pickBanner({
    notify,
    dismissed,
    me,
    // контакты ещё не пришли — про дни рождения молчим, а не мигаем другой подсказкой
    contacts: contacts.map((c) => ({ userId: c.userId, name: c.name || 'Контакт', birthday: c.birthday ?? null })),
    today: new Date(),
  }), [notify, dismissed, me, contacts, day]);
  const ready = loaded || notify === 'default';
  const want = ready ? banner : null;
  // Смена подсказки: прежняя сворачивается, новая раскрывается — текст не меняется посреди анимации
  const [cur, setCur] = useState<Banner | null>(want);
  const same = (x: Banner | null, y: Banner | null) => JSON.stringify(x) === JSON.stringify(y);
  const swap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wantRef = useRef(want);
  wantRef.current = want;
  useEffect(() => {
    if (same(want, cur)) return;
    if (cur && want && cur.kind === want.kind) { setCur(want); return; }   // та же подсказка, обновились данные
    if (!cur) { setCur(want); return; }
    if (swap.current) return;
    swap.current = setTimeout(() => { swap.current = null; setCur(wantRef.current); }, 240);
  });
  useEffect(() => () => { if (swap.current) clearTimeout(swap.current); }, []);
  const shown = cur && same(want, cur) ? cur : cur && want && cur.kind === want.kind ? cur : null;
  const last = useRef<Banner | null>(null);
  if (cur) last.current = cur;
  const b = cur ?? last.current;

  const close = (x: Banner) => {
    const d = dismiss(dismissed, x, new Date());
    saveDismissed(d);
    setDismissed(d);
    if (x.kind === 'notify') showToast('Уведомления можно включить в настройках');
  };
  const open = (x: Banner) => {
    if (x.kind === 'notify') void setNotify(true).then(() => { if (getGlobal().notify !== 'default') close(x); });
    else if (x.kind === 'setBirthday') void go('settings/profile');
    else if (x.people.length === 1) void openDirect(x.people[0].userId);
    else void go('contacts');
  };

  return (
    <Presence show={!!shown} exitMs={220}>
      {b ? (
        <div class="app-banner-slot">
          <div class="app-banner-clip">
            <div class="app-banner" role="button" tabIndex={0} onPointerDown={ripple} onClick={() => open(b)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(b); } }}>
              {b.kind === 'birthdays' ? (
                <>
                  <div class="app-banner-text">
                    <b>🎉 {b.people.length === 1 ? `Сегодня день рождения у ${b.people[0].name}` : `Сегодня ${b.people.length} ${plural(b.people.length, 'контакт празднует', 'контакта празднуют', 'контактов празднуют')} день рождения`}</b>
                    <span>{b.people.length === 1 ? 'Напишите поздравление.' : 'Выберите, кого поздравить.'}</span>
                  </div>
                  <div class="app-banner-faces" aria-hidden="true">
                    {b.people.slice(0, 3).map((p) => <Avatar key={p.userId} name={p.name} tone={peerTone(p.userId)} size={28} />)}
                  </div>
                </>
              ) : (
                <div class="app-banner-text"><b>{TEXT[b.kind].title}</b><span>{TEXT[b.kind].text}</span></div>
              )}
              <span class="app-banner-x" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                <IconButton icon="close" label="Скрыть" size={18} onClick={() => close(b)} />
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </Presence>
  );
}
