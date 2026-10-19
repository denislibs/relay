import { ConfirmDialog, InfoRow, Section, SearchInput, WindowList } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { diagnosticsFile, downloadText } from '../../devtools/diagnostics';
import { getErrors } from '../../devtools/metrics';
import { devSnapshot } from '../../devtools/session';
import { useGlobal } from '../../global';
import { go } from '../../nav';
import { devCall, getPendingOps, resetLocal, showToast } from '../../settingsData';
import { clearLocalDialog } from './clearLocal';

declare const __BUILD__: string;

interface Row { key: string; value: Record<string, unknown> }
interface Page { rows: Row[]; offset: number; more: boolean }
const PAGE = 100;
const MSG_ROW = 30;

const read = (args: Record<string, unknown>) => devCall<Page>('idbRead', args);
const short = (v: unknown, n = 90) => { const s = JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };

/** Сообщения одного чата из IDB: виртуальный список, подгрузка страницами, поиск по ключу. */
function Messages(props: { chatId: number }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [more, setMore] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const gen = useRef(0);
  const loading = useRef(false);
  const load = (reset: boolean, query = q) => {
    if (loading.current && !reset) return;
    const g = reset ? ++gen.current : gen.current;
    loading.current = true;
    void read({ store: 'messages', chatId: props.chatId, q: query, offset: reset ? 0 : rows.length, limit: PAGE }).then((p) => {
      if (g !== gen.current) return;
      setRows((r) => (reset ? p.rows : r.concat(p.rows)));
      setMore(p.more);
    }, () => showToast('Не удалось прочитать IDB')).finally(() => { if (g === gen.current) loading.current = false; });
  };
  useEffect(() => { load(true, ''); }, [props.chatId]);
  const cur = open ? rows.find((r) => r.key === open) : null;
  return (
    <>
      <SearchInput id="dev-msg-search" label="Поиск по ключу" placeholder="Ключ сообщения" value={q} onInput={(e: Event) => { const v = (e.currentTarget as HTMLInputElement).value; setQ(v); load(true, v); }} />
      <div class="app-dev-idb" role="list" aria-label="Сообщения в IDB">
        {rows.length ? (
          <WindowList items={rows} rowHeight={MSG_ROW} getKey={(r: Row) => r.key} onNearEnd={more ? () => load(false) : undefined} render={(r: Row) => (
            <button type="button" role="listitem" class={'app-dev-idbrow' + (open === r.key ? ' app-dev-ev-on' : '')} onClick={() => setOpen(open === r.key ? null : r.key)}>
              <b>{r.key}</b><span>{short({ id: r.value.id, sort: r.value.sort, status: r.value.status, body: r.value.body })}</span>
            </button>
          )} />
        ) : <p class="app-dev-empty">{q ? 'Ничего не найдено' : 'Сообщений нет'}</p>}
      </div>
      {cur ? <pre class="app-dev-pre">{JSON.stringify(cur.value, null, 2)}</pre> : null}
    </>
  );
}

/** «Данные»: просмотр IDB (только чтение, через движок) и служебные действия. */
export function DevData() {
  const status = useGlobal((s) => s.status);
  const [chats, setChats] = useState<Row[] | null>(null);
  const [meta, setMeta] = useState<Row[] | null>(null);
  const [chatId, setChatId] = useState<number | null>(null);
  const [ask, setAsk] = useState(false);
  const [unsent, setUnsent] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => {
    void read({ store: 'chats', limit: 200 }).then((p) => setChats(p.rows), () => setChats([]));
    void read({ store: 'meta', limit: 50 }).then((p) => setMeta(p.rows), () => setMeta([]));
  };
  useEffect(refresh, []);

  const act = async (name: string, fn: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(name);
    try { await fn(); showToast(ok); } catch (e) { showToast((e as Error)?.message === 'offline' ? 'Нет сети' : 'Не удалось выполнить'); }
    setBusy(null);
    refresh();
  };
  const updateSw = () => act('sw', async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) throw new Error('no sw');
    await reg.update();
  }, 'Service Worker проверен на обновление');
  const clearLocal = async (keepOutbox: boolean) => {
    setAsk(false);
    try { await resetLocal(keepOutbox); void go('chats'); } catch { showToast('Не удалось очистить данные, попробуйте ещё раз'); }
  };
  const diag = () => {
    const snap = devSnapshot();
    const f = diagnosticsFile(__BUILD__, {
      overview: snap.stats, server: snap.server, main: snap.main,
      log: snap.log.slice(-2000).map(({ key: _k, ...e }) => e),
      errors: getErrors(),
      ua: navigator.userAgent,
    });
    downloadText(f.name, f.json);
  };
  const dlg = clearLocalDialog(unsent, (keep) => void clearLocal(keep));

  return (
    <div class="rl-settings app-dev-scroll">
      <Section title="Чаты в IDB">
        {chats == null ? <p class="app-dev-empty">…</p> : chats.length ? chats.map((c) => (
          <button key={c.key} type="button" class={'app-dev-idbrow' + (chatId === Number(c.key) ? ' app-dev-ev-on' : '')} onClick={() => setChatId(chatId === Number(c.key) ? null : Number(c.key))}>
            <b>{c.key}</b><span>{short({ title: c.value.title, kind: c.value.kind, unread: c.value.unread, last: (c.value.last as Record<string, unknown> | null)?.id })}</span>
          </button>
        )) : <p class="app-dev-empty">Чатов нет</p>}
      </Section>
      {chatId != null ? (
        <Section title={`Сообщения чата ${chatId}`}>
          <Messages chatId={chatId} />
        </Section>
      ) : null}
      <Section title="meta">
        {meta?.map((r) => <div key={r.key} class="app-kv"><span>{r.key}</span><b title={JSON.stringify(r.value.v)}>{short(r.value.v, 60)}</b></div>)}
      </Section>
      <Section title="Действия">
        <InfoRow icon="history" title="Пересинхронизировать" subtitle="Снимок заново, без очистки" onClick={() => void act('resync', () => devCall('resync'), 'Снимок взят')} />
        <InfoRow icon="trash" danger title="Очистить локальные данные" onClick={() => { setUnsent(status.outbox + status.failed + getPendingOps()); setAsk(true); }} />
        <InfoRow icon="download" title="Обновить Service Worker" onClick={() => void updateSw()} />
        <InfoRow icon="rocket" title="Перезапустить воркер" subtitle="Все вкладки переподключатся" onClick={() => void act('restart', () => devCall('restartWorker'), 'Воркер перезапущен')} />
        <InfoRow icon="file" title="Скачать диагностику" subtitle="Обзор, журнал и ошибки — без текстов сообщений" onClick={diag} />
      </Section>
      <ConfirmDialog open={ask} extra={dlg.extra} danger title={dlg.title} text={dlg.text} confirm={dlg.confirm} cancel="Отмена" onCancel={() => setAsk(false)} onConfirm={() => dlg.run()} />
    </div>
  );
}
