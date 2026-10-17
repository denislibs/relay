import { Button, InfoRow, Section } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { useDevStats, useMainMetrics, useServerStats } from '../../devtools/session';
import { useGlobal } from '../../global';
import { devCall, showToast } from '../../settingsData';
import { KV, ago, bytes, dur, ms, num } from './devui';

declare const __BUILD__: string;

type Rec = Record<string, any>;   // снимок devStats — данные движка, поля см. devstats.ts

interface SwInfo { state: string; update: boolean }
/** Состояние Service Worker: active / waiting («есть обновление») / installing. */
function useServiceWorker(): SwInfo | null {
  const [info, setInfo] = useState<SwInfo | null>(null);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) { setInfo({ state: 'не поддерживается', update: false }); return; }
    let reg: ServiceWorkerRegistration | undefined, alive = true;
    const read = () => {
      if (!alive) return;
      if (!reg) { setInfo({ state: 'не зарегистрирован', update: false }); return; }
      setInfo({ state: reg.installing ? 'installing' : reg.waiting ? 'waiting' : reg.active ? 'active' : '—', update: !!reg.waiting });
    };
    void navigator.serviceWorker.getRegistration().then((r) => { reg = r; r?.addEventListener('updatefound', read); read(); });
    return () => { alive = false; reg?.removeEventListener('updatefound', read); };
  }, []);
  return info;
}

interface StoreInfo { used: number | null; quota: number | null; caches: [string, number][]; local: [string, number][] }
/** Хранилище: storage.estimate, Cache Storage по кэшам (число записей), ключи relay.* в localStorage. Раз в 10 с, пока вкладка видна. */
function useStorage(active: boolean): StoreInfo | null {
  const [info, setInfo] = useState<StoreInfo | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const read = async () => {
      const est = await navigator.storage?.estimate?.().catch(() => null);
      const caches_: [string, number][] = [];
      try { for (const name of await caches.keys()) caches_.push([name, (await (await caches.open(name)).keys()).length]); } catch { /* нет Cache Storage */ }
      const local: [string, number][] = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.startsWith('relay.')) local.push([k, (localStorage.getItem(k) ?? '').length]); } } catch { /* приватный режим */ }
      local.sort((a, b) => a[0].localeCompare(b[0]));
      if (alive) setInfo({ used: est?.usage ?? null, quota: est?.quota ?? null, caches: caches_, local });
    };
    void read();
    const t = setInterval(read, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [active]);
  return info;
}

const PHASE: Record<string, string> = { connecting: 'connecting', loading: 'loading', updating: 'updating', ready: 'ready', offline: 'offline' };

export function DevOverview(props: { onHide: () => void }) {
  const active = useGlobal((s) => s.devTab === 'overview');
  const st = useDevStats() as Rec | null;
  const m = useMainMetrics();
  const srv = useServerStats();
  const sw = useServiceWorker();
  const store = useStorage(active);
  const [busy, setBusy] = useState<string | null>(null);

  const host = st?.host as Rec | null;
  const sync = (st?.sync ?? {}) as Rec;
  const sock = (st?.socket ?? {}) as Rec;
  const q = (st?.queues ?? { outbox: { pending: 0, failed: 0, byChat: {} }, ops: {} }) as Rec;
  const subs = (st?.subscriptions ?? []) as Rec[];
  const idb = st?.idb as Record<string, number> | null;
  const s = srv.stats;
  const hostName = typeof SharedWorker === 'function'
    ? 'SharedWorker'
    : 'Dedicated' + (host?.kind === 'dedicated-leader' ? ' · данные от лидера (Web Locks)' : '');

  const act = async (cmd: 'retryFailed' | 'discardFailed') => {
    if (busy) return;
    setBusy(cmd);
    try {
      const r = await devCall<{ count: number }>(cmd);
      showToast(cmd === 'retryFailed' ? `Снова в очереди: ${r.count}` : `Отброшено: ${r.count}`);
    } catch { showToast('Не удалось выполнить'); }
    setBusy(null);
  };

  return (
    <div class="rl-settings app-dev-scroll">
      <Section title="Сборка и база">
        <KV label="Сборка" value={__BUILD__} />
        <KV label="Эпоха сервера" value={st?.epoch as string} />
        <KV label="userId" value={num(st?.userId)} />
        <KV label="Версия IDB" value={num(st?.idbVersion)} />
        <KV label="Service Worker" value={sw ? sw.state + (sw.update ? ' · есть обновление' : '') : '…'} warn={sw?.update} />
      </Section>

      <Section title="Воркер">
        <KV label="Хост" value={hostName} />
        <KV label="Клиентов хоста (порты вкладок)" value={num(host?.clients)} title="У каждой вкладки два порта: данные и настройки" />
        <KV label="Аптайм воркера" value={dur(host?.uptimeMs)} />
        <KV label="Аптайм движка" value={dur(st?.engineUptimeMs)} />
        <KV label="Пульс (ping → pong)" value={ms(st?.pingMs)} />
      </Section>

      <Section title="Синхронизация">
        <KV label="lastSeq клиента" value={num(sync.lastSeq)} />
        <KV label="seq сервера (hello)" value={num(sync.serverSeq)} />
        <KV label="Отставание" value={num(sync.lag)} warn={(sync.lag ?? 0) > 0} />
        <KV label="Фаза" value={PHASE[sync.phase] ?? sync.phase} />
        <KV label="Последний sync" value={ago(sync.lastSyncAt)} />
        <KV label="tooLong за сессию" value={num(sync.tooLongCount)} />
        <KV label="Сокет" value={sock.state} warn={sock.state && sock.state !== 'open'} />
        <KV label="Попытка переподключения" value={num(sock.attempt)} />
        <KV label="Следующая задержка" value={sock.nextDelay == null ? '—' : ms(sock.nextDelay)} />
      </Section>

      <Section title="Сервер" footer={srv.error === 'unavailable' ? 'Сервер запущен без DEV_LOGIN — статистика недоступна.' : srv.error === 'offline' ? 'Нет ответа сервера.' : 'GET /dev/stats раз в 2 с, пока открыта эта вкладка.'}>
        <KV label="seq пользователя" value={num(s?.seq)} />
        <KV label="Сокетов (этот процесс)" value={num(s?.sockets)} />
        <KV label="Записей журнала" value={num(s?.journal.size)} />
        <KV label="min(seq) журнала" value={num(s?.journal.minSeq)} />
        <KV label="NOTIFY → poke" value={s?.notifyMs == null ? '—' : `${s.notifyMs.toFixed(1)} мс`} />
      </Section>

      <Section title="Очереди">
        <KV label="Outbox: в очереди" value={num(q.outbox.pending)} />
        <KV label="Outbox: с ошибкой" value={num(q.outbox.failed)} warn={q.outbox.failed > 0} />
        {Object.entries(q.outbox.byChat as Record<string, { pending: number; failed: number }>).map(([chat, c]) => (
          <KV key={chat} label={'  чат ' + chat} value={`${c.pending} / ${c.failed}`} />
        ))}
        <KV label="pendingReads" value={num(q.pendingReads)} />
        <KV label="Операции настроек" value={num(q.ops?.pending)} title={(q.ops?.keys ?? []).join(', ')} />
        <KV label="Отказы операций" value={num(q.ops?.failures)} />
        <div class="app-dev-actions">
          <Button variant="secondary" disabled={!!busy} onClick={() => void act('retryFailed')}>Повторить все</Button>
          <Button variant="secondary" disabled={!!busy} onClick={() => void act('discardFailed')}>Отбросить failed</Button>
        </div>
      </Section>

      <Section title="Подписки">
        <div class="app-dev-table" role="table" aria-label="Подписки">
          <div class="app-dev-tr app-dev-th" role="row"><span role="columnheader">Подписка</span><span role="columnheader">Элем.</span><span role="columnheader">Патч/с</span><span role="columnheader">Байт</span><span role="columnheader">Снимок</span></div>
          {subs.map((x) => (
            <div key={x.id} class="app-dev-tr" role="row">
              <span role="cell" title={x.key}>{x.key}</span>
              <span role="cell">{num(x.items)}</span>
              <span role="cell">{typeof x.patchesPerSec === 'number' ? x.patchesPerSec.toFixed(1) : '—'}</span>
              <span role="cell">{x.lastPatchBytes == null ? '—' : num(x.lastPatchBytes)}</span>
              <span role="cell">{x.sinceSnapshotMs == null ? '—' : dur(x.sinceSnapshotMs)}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Хранилище">
        <KV label="Использовано" value={store ? bytes(store.used) : '…'} />
        <KV label="Квота" value={store ? bytes(store.quota) : '…'} />
        {idb ? Object.entries(idb).map(([k, n]) => <KV key={k} label={'IDB · ' + k} value={num(n)} />) : <KV label="IDB" value="…" />}
        {store?.caches.map(([k, n]) => <KV key={'c' + k} label={'Cache · ' + k} value={num(n) + ' записей'} />)}
        {store?.local.map(([k, n]) => <KV key={'l' + k} label={'localStorage · ' + k} value={bytes(n)} />)}
      </Section>

      <Section title="Главный поток" footer="Считается, только пока открыт этот раздел.">
        <KV label="FPS" value={m?.fps == null ? '…' : String(m.fps)} warn={m?.fps != null && m.fps < 50} />
        <KV label="Long tasks за минуту" value={m?.longTasks ? `${m.longTasks.count} · макс. ${ms(m.longTasks.maxMs)}` : 'не поддерживается'} />
        <KV label="Кадр: measure / mutate" value={m ? `${m.frame.measures} / ${m.frame.mutations}` : '…'} />
        <KV label="isHeavyAnimating" value={m ? (m.frame.heavy ? 'да' : 'нет') : '…'} />
        <KV label="Отложено deferDuringAnimation" value={m ? `${num(m.frame.deferred)} · ждут ${m.frame.waiting}` : '…'} />
        {m?.memory ? <KV label="Память JS" value={`${bytes(m.memory.used)} / ${bytes(m.memory.limit)}`} /> : null}
        <KV label="DOM-узлов" value={m ? num(m.domNodes) : '…'} />
      </Section>

      <Section footer="Раздел снова откроется после пяти нажатий на заголовок «Настройки».">
        <InfoRow icon="close" title="Скрыть раздел" onClick={props.onHide} />
      </Section>
    </div>
  );
}
