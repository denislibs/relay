import { Avatar, ChatRowSkeleton, EmptyState, FolderTabs, Icon, IconButton, PanelHeader, peerTone, Presence, ripple, useMinVisible } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { callBack } from '../../calls/callUi';
import { fetchCalls, groupCalls, groupText, isMissed, markCallsSeen, type CallGroup, type CallRow } from '../../calls/callsList';
import { openChat } from '../../data';
import { useGlobal } from '../../global';
import { back } from '../../nav';
import { avatarPhoto } from '../../profilePhoto';
import { chatTime } from '../format';

type Tab = 'all' | 'missed';

/** Строка: аватар, имя (с числом звонков в группе), направление и вид, время; справа — перезвонить тем же видом. */
function CallItem({ g }: { g: CallGroup }) {
  const r = g.rows[0];
  const chat = useGlobal((s) => s.chats.find((c) => c.id === r.chatId));
  const name = String(chat?.title ?? '') || r.name || 'Пользователь';
  const missed = isMissed(r), bad = missed || r.reason === 'declined';
  return (
    <div class="app-callrow" role="listitem">
      <button type="button" class="app-callrow-main" onPointerDown={ripple} onClick={() => openChat(r.chatId)}>
        <Avatar name={name} tone={peerTone(r.peerId)} size={48} {...avatarPhoto(r.photo)} />
        <span class="app-callrow-text">
          <span class={'app-callrow-name' + (missed ? ' is-missed' : '')}>{name}{g.rows.length > 1 ? ` (${g.rows.length})` : ''}</span>
          <span class="app-callrow-sub">
            <Icon name="arrowRight" size={16} class={'app-callbubble-arrow' + (r.outgoing ? ' is-out' : ' is-in') + (bad ? ' is-missed' : '')} />
            {groupText(g)}
          </span>
        </span>
        <span class="app-callrow-time">{chatTime(r.at)}</span>
      </button>
      <IconButton icon={r.video ? 'video' : 'phone'} label={r.video ? 'Видеозвонок' : 'Позвонить'} class="app-callrow-call" onClick={() => callBack(r.chatId, r.video)} />
    </div>
  );
}

/** «Звонки» (меню левой колонки): все или только пропущенные, страницами по 50 при прокрутке. */
export function Calls() {
  const [tab, setTab] = useState<Tab>('all');
  const [rows, setRows] = useState<CallRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const loading = useRef(false);
  const gen = useRef(0);
  const tabNow = useRef(tab);   // отложенное обновление (конец звонка) — по вкладке на момент загрузки, а не на момент таймера
  tabNow.current = tab;
  const rowsNow = useRef(rows);
  rowsNow.current = rows;
  const call = useGlobal((s) => s.call);

  const load = async (reset: boolean) => {
    if (loading.current && !reset) return;
    const my = reset ? ++gen.current : gen.current;
    loading.current = true;
    try {
      const cur = rowsNow.current;
      const page = await fetchCalls({ missed: tabNow.current === 'missed', before: reset ? undefined : cur?.[cur.length - 1] });
      if (my !== gen.current) return;
      setRows((prev) => (reset || !prev ? page.calls : [...prev, ...page.calls]));
      setMore(page.more);
      setFailed(false);
    } catch { if (my === gen.current) setFailed(true); }
    finally { if (my === gen.current) loading.current = false; }
  };

  useEffect(() => { markCallsSeen(); }, []);
  useEffect(() => { setRows(null); void load(true); }, [tab]);
  // звонок закончился — его строка уже в истории: первая страница заново (бейдж — сразу «видел»)
  const hadCall = useRef(!!call);
  useEffect(() => {
    if (hadCall.current && !call) { const t = setTimeout(() => { void load(true); markCallsSeen(); }, 800); return () => clearTimeout(t); }
    hadCall.current = !!call;
  }, [call]);

  // подгрузка: нижний край списка на экране — следующая страница
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = tail.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) void load(false); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, rows]);

  const waiting = rows === null && !failed;
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const groups = rows ? groupCalls(rows) : [];

  return (
    <div class="rl-sidepage" aria-label="Список звонков">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Звонки" onClose={() => void back()} />
      <FolderTabs label="Звонки" active={tab} onChange={(t: Tab) => setTab(t)} items={[{ id: 'all', label: 'Все' }, { id: 'missed', label: 'Пропущенные' }]} />
      <div class="rl-page-scroll app-calls">
        <div class="app-listwrap">
          <Presence show={skeleton} exitMs={280}>
            <div class="app-skel" aria-busy="true" aria-label="Загрузка звонков">
              {Array.from({ length: 8 }, (_, i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}
            </div>
          </Presence>
          {waiting || skeleton ? null : groups.length ? (
            <div role="list">
              {groups.map((g) => <CallItem key={g.key} g={g} />)}
              {more ? <div ref={tail} class="app-calls-tail" /> : null}
            </div>
          ) : failed ? (
            <EmptyState kind="chats" title="Нет сети" text="Звонки загрузятся, когда появится подключение." />
          ) : (
            <EmptyState kind="chats" title={tab === 'missed' ? 'Пропущенных нет' : 'Звонков пока нет'} text="Позвонить можно из любого личного чата — кнопка с трубкой в шапке." />
          )}
        </div>
      </div>
    </div>
  );
}
