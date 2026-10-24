import { Button, ContactPicker, EmptyState, Fab, PanelHeader, Presence, ProfileHeader, ProgressRing, Section, TextField, peerTone } from '@relay/ui';
import { GROUP_ABOUT_MAX } from '@relay/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createGroup, groupCall, openChat } from '../../data';
import { getGlobal, setGlobal, useGlobal } from '../../global';
import { back, go, home } from '../../nav';
import { senderAvatar, upload } from '../../profilePhoto';
import { showToast } from '../../settingsData';
import { errorText } from '../../groups';
import { isSystemChat } from '../format';
import { candidates } from '../settings/privacyLogic';
import { usePhotoPicker } from '../settings/usePhotoPicker';
import { GROUP_TITLE_MAX } from './NewGroup';

// «Новый канал» — как в Telegram Web K: шаг 1 — название, описание и фото; канал создаётся сразу (без подписчиков),
// шаг 2 — «Добавить подписчиков» (можно пропустить), затем канал открывается. Тип и @имя — потом, в настройках.
// Черновик живёт в global.newChannel между шагами; после создания в нём chatId.

type Cropped = { big: Blob; small: Blob; thumb: string };
const cpLen = (s: string) => [...s].length;
const clip = (s: string, max: number) => [...s].slice(0, max).join('');

export function NewChannelInfo() {
  const draft = useGlobal((s) => s.newChannel);
  const [title, setTitle] = useState(draft?.title ?? '');
  const [about, setAbout] = useState(draft?.about ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // фото выбирают до создания: обрезанное держим здесь, загружаем, когда канал появится
  const photoRef = useRef<Cropped | null>(null);
  const photo = usePhotoPicker(null, { set: async (c) => { photoRef.current = c; }, remove: async () => { photoRef.current = null; } });
  useEffect(() => { if (!getGlobal().newChannel) setGlobal({ newChannel: { title: '', about: '', chatId: null } }); }, []);
  const leave = () => { setGlobal({ newChannel: null }); void back(); };

  async function create() {
    const t = title.trim();
    if (!t) { setErr('Введите название канала'); return; }
    // уже создан (вернулись со второго шага) — дальше, второй канал не создаём
    const made = getGlobal().newChannel?.chatId;
    if (made) { void go('newChannel/members'); return; }
    setBusy(true);
    try {
      const id = await createGroup(t, [], { about: about.trim() });
      setGlobal({ newChannel: { title: t, about: about.trim(), chatId: id } });
      const c = photoRef.current;
      if (c) {
        // фото — отдельным запросом после создания (как в Telegram); не вышло — канал всё равно есть
        void Promise.all([upload(c.big, 640), upload(c.small, 160)])
          .then(([big, small]) => groupCall('PUT', `/groups/${id}/photo`, { id: big, small, thumb: c.thumb }))
          .then((r) => { if (!r.ok) showToast('Не удалось поставить фото канала'); }, () => showToast('Не удалось поставить фото канала'));
      }
      void go('newChannel/members');
    } catch (e) {
      showToast((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div class="rl-sidepage" aria-label="Новый канал">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Новый канал" onClose={leave} />
      <div class="rl-settings app-newgroup">
        <ProfileHeader name={title.trim()} tone={5} size={120} {...photo.avatar} />
        {photo.ui}
        <Section footer="Можно добавить описание канала — его увидят подписчики.">
          <form class="app-newgroup-name" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <TextField label="Название канала" value={title} maxLength={GROUP_TITLE_MAX} measure={cpLen} autoFocus error={err ?? undefined}
              onInput={(v: string, e: Event) => { const c = clip(v.replace(/^\s+/, ''), GROUP_TITLE_MAX); if (c !== v) (e.currentTarget as HTMLInputElement).value = c; setErr(null); setTitle(c); }} />
            <TextField label="Описание" multiline rows={3} counter value={about} maxLength={GROUP_ABOUT_MAX} measure={cpLen}
              onInput={(v: string, e: Event) => { const c = clip(v, GROUP_ABOUT_MAX); if (c !== v) (e.currentTarget as HTMLTextAreaElement).value = c; setAbout(c); }} />
          </form>
        </Section>
      </div>
      <Presence show={!!title.trim()} exitMs={200}>
        <div class="rl-fab-slot">
          {busy ? <span class="rl-fab-main app-newgroup-busy" role="status" aria-label="Создаём канал"><ProgressRing size={28} onMedia /></span>
            : <Fab icon="arrowRight" label="Далее" onClick={() => void create()} />}
        </div>
      </Presence>
    </div>
  );
}

export function NewChannelMembers() {
  const me = useGlobal((s) => s.me!.userId);
  const contacts = useGlobal((s) => s.contacts);
  const chats = useGlobal((s) => s.chats);
  const chatId = useGlobal((s) => s.newChannel?.chatId ?? null);
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!getGlobal().newChannel?.chatId) void back(); }, []);   // пришли без канала (перезагрузка) — на шаг назад
  const recent = new Map<number, number>();
  chats.forEach((c, i) => { if (c.kind === 'direct' && typeof c.peerId === 'number' && !recent.has(c.peerId)) recent.set(c.peerId, i); });
  const people = candidates(contacts, chats.filter((c) => !isSystemChat(c)), me)
    .sort((a, b) => (recent.get(a.id) ?? Infinity) - (recent.get(b.id) ?? Infinity) || a.name.localeCompare(b.name, 'ru'));

  // готово (или «Пропустить»): канал — нижним чатом (новое из левой колонки заменяет стек)
  const finish = async () => {
    if (!chatId) return;
    setGlobal({ newChannel: null });
    await home();
    openChat(chatId);
  };
  const add = async () => {
    if (!chatId) return;
    if (!picked.length) { void finish(); return; }
    setBusy(true);
    const r = await groupCall<{ added: number[]; failed: number[] }>('POST', `/groups/${chatId}/members`, { userIds: picked });
    setBusy(false);
    if (!r.ok) { showToast(errorText(r.code)); return; }
    if (r.data.failed.length) showToast(`Не удалось добавить: ${r.data.failed.length}`);
    void finish();
  };

  return (
    <div class="rl-sidepage" aria-label="Добавить подписчиков">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Добавить подписчиков" onClose={() => void back()} />
      <Button variant="ghost" class="app-newchannel-skip" onClick={() => void finish()}>Пропустить</Button>
      <div class="rl-page-scroll app-newgroup">
        {people.length ? (
          <ContactPicker multi selected={picked} contacts={people.map((p) => ({ ...p, tone: peerTone(p.id), avatar: senderAvatar(p.id) }))}
            searchLabel="Поиск людей" placeholder="Кого добавить?" onChange={(next: number[]) => setPicked(next)} />
        ) : (
          <EmptyState kind="contacts" title="Некого добавить" text="Подписчики появятся, когда вы поделитесь ссылкой на канал." />
        )}
      </div>
      <Presence show={picked.length > 0} exitMs={200}>
        <div class="rl-fab-slot">
          {busy ? <span class="rl-fab-main app-newgroup-busy" role="status" aria-label="Добавляем подписчиков"><ProgressRing size={28} onMedia /></span>
            : <Fab icon="check" label="Добавить подписчиков" onClick={() => void add()} />}
        </div>
      </Presence>
    </div>
  );
}
