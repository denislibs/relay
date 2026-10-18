import { Avatar, ContactPicker, EmptyState, Fab, Icon, PanelHeader, Presence, ProgressRing, Section, TextField, peerTone } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { createGroup, openChat } from '../../data';
import { getGlobal, setGlobal, useGlobal } from '../../global';
import { back, go, home } from '../../nav';
import { showToast } from '../../settingsData';
import { isSystemChat } from '../format';
import { candidates, type Person } from '../settings/privacyLogic';

// «Новая группа» — как в Telegram Web A: шаг 1 — участники (поиск, выбранные «чипами» сверху),
// шаг 2 — название (для 1–4 участников подставляется из имён) и список участников; создаём кнопкой.
// Выбор живёт в global.newGroup между шагами; «Назад» с первого шага — черновик сбрасывается.

export const GROUP_TITLE_MAX = 128;

function usePeople(): Person[] {
  const me = useGlobal((s) => s.me!.userId);
  const contacts = useGlobal((s) => s.contacts);
  const chats = useGlobal((s) => s.chats);
  // как в Telegram: сначала те, с кем переписывались недавно (порядок списка чатов), потом остальные контакты по алфавиту
  const recent = new Map<number, number>();
  chats.forEach((c, i) => { if (c.kind === 'direct' && typeof c.peerId === 'number' && !recent.has(c.peerId)) recent.set(c.peerId, i); });
  return candidates(contacts, chats.filter((c) => !isSystemChat(c)), me)
    .sort((a, b) => (recent.get(a.id) ?? Infinity) - (recent.get(b.id) ?? Infinity) || a.name.localeCompare(b.name, 'ru'));
}

/** «Анна, Борис и Вера» — имена (первое слово) создателя и до трёх участников; больше — без подсказки. */
export function autoTitle(me: string, names: string[]): string {
  if (!names.length || names.length > 3) return '';
  const first = (n: string) => n.trim().split(/\s+/)[0] ?? '';
  const all = [me, ...names].map(first).filter(Boolean);
  return all.length > 1 ? all.slice(0, -1).join(', ') + ' и ' + all[all.length - 1] : all[0] ?? '';
}

export function NewGroupMembers() {
  const people = usePeople();
  const draft = useGlobal((s) => s.newGroup);
  const ids = draft?.ids ?? [];
  useEffect(() => { if (!getGlobal().newGroup) setGlobal({ newGroup: { ids: [], title: '', edited: false } }); }, []);
  const leave = () => { setGlobal({ newGroup: null }); void back(); };
  const setIds = (next: number[]) => setGlobal((s) => ({ newGroup: { ...(s.newGroup ?? { title: '', edited: false }), ids: next } }));

  return (
    <div class="rl-sidepage" aria-label="Новая группа: участники">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Добавить участников" onClose={leave} />
      <div class="rl-page-scroll app-newgroup">
        {people.length ? (
          <ContactPicker multi selected={ids} contacts={people.map((p) => ({ ...p, tone: peerTone(p.id) }))}
            searchLabel="Поиск людей" placeholder="Кого добавить?" onChange={(next: number[]) => setIds(next)} />
        ) : (
          <EmptyState kind="contacts" title="Некого добавить" text="Добавьте людей в контакты или начните с ними переписку — они появятся здесь." />
        )}
      </div>
      <Presence show={ids.length > 0} exitMs={200}>
        <div class="rl-fab-slot"><Fab icon="arrowRight" label="Далее" onClick={() => void go('newGroup/name')} /></div>
      </Presence>
    </div>
  );
}

export function NewGroupName() {
  const people = usePeople();
  const meName = useGlobal((s) => s.me!.name);
  const draft = useGlobal((s) => s.newGroup);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ids = draft?.ids ?? [];
  const members = ids.map((id) => people.find((p) => p.id === id) ?? { id, name: 'Пользователь', about: '' });
  // название из имён — пока его не правили руками
  const suggested = autoTitle(meName, members.map((m) => m.name));
  const title = draft?.edited ? draft.title : suggested;
  useEffect(() => { if (!draft?.ids.length) void back(); }, []);   // пришли без участников (перезагрузка) — на шаг назад

  const setTitle = (v: string) => { setErr(null); setGlobal((s) => ({ newGroup: { ...(s.newGroup ?? { ids: [] }), title: v.replace(/^\s+/, ''), edited: true } })); };
  async function create() {
    const t = title.trim();
    if (!t) { setErr('Введите название группы'); return; }
    setBusy(true);
    try {
      const id = await createGroup(t, ids);
      setGlobal({ newGroup: null });
      await home();
      openChat(id);
    } catch (e) {
      showToast((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div class="rl-sidepage" aria-label="Новая группа">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Новая группа" onClose={() => void back()} />
      {/* как страницы настроек: серый фон, белые карточки; фото — по центру, поле названия — на всю ширину карточки */}
      <div class="rl-settings app-newgroup">
        <div class="app-newgroup-head">
          <span class="app-newgroup-photo" aria-hidden="true"><Icon name="community" size={44} /></span>
        </div>
        <Section>
          <form class="app-newgroup-name" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <TextField label="Название группы" value={title} maxLength={GROUP_TITLE_MAX} autoFocus error={err ?? undefined}
              onInput={(v: string) => setTitle(v)} />
          </form>
        </Section>
        <Section title={`${members.length + 1} ${plural(members.length + 1)}`}>
          <div role="list">
            {members.map((m) => (
              <div key={m.id} role="listitem" class="rl-row app-newgroup-row">
                <Avatar name={m.name} tone={peerTone(m.id)} size={42} />
                <span class="rl-row-main"><span class="rl-row-name">{m.name}</span><span class="rl-row-preview">{m.about}</span></span>
              </div>
            ))}
          </div>
        </Section>
      </div>
      <Presence show={!!title.trim()} exitMs={200}>
        <div class="rl-fab-slot">
          {busy ? <span class="rl-fab-main app-newgroup-busy" role="status" aria-label="Создаём группу"><ProgressRing size={28} onMedia /></span>
            : <Fab icon="check" label="Создать группу" onClick={() => void create()} />}
        </div>
      </Presence>
    </div>
  );
}

const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'участник' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'участника' : 'участников');
