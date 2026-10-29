import { ChatRowSkeleton, ConfirmDialog, InfoRow, PanelHeader, Presence, ProgressRing, RangeRow, Section, Switch, useMinVisible } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { autoloadSubtitle, isDefaultAutoload, type MediaKind } from '../../autoload';
import { useGlobal } from '../../global';
import { back, go } from '../../nav';
import { CACHE_MB, defaultPrefs, KEEP_DAYS, setPref, setPrefs } from '../../prefs';
import { getPendingOps, resetLocal, showToast, storageStats } from '../../settingsData';
import { clearMediaCaches, dbRowsLabel, formatBytes, plural, readStorage, within, type StorageInfo } from '../../storageInfo';
import { useScrollMemory } from '../useScrollMemory';
import { clearLocalDialog } from './clearLocal';

const KEEP_LABEL: Record<number, string> = { 1: '1 день', 7: '1 неделя', 30: '1 месяц', 0: 'Всегда' };
const KEEP_MARK: Record<number, string> = { 1: '1 д', 7: '1 нед', 30: '1 мес', 0: '∞' };
const filesLabel = (n: number) => `${n} ${plural(n, 'файл', 'файла', 'файлов')}`;
/** Сколько ждём строки базы от воркера: дольше — строка размера без них (прежние строки остаются). */
const ROWS_WAIT_MS = 600;
const mbLabel = (mb: number) => (mb === 0 ? 'Без лимита' : mb >= 1000 ? `${mb / 1000} ГБ` : `${mb} МБ`);

const KINDS: [MediaKind, string, string, 'blue' | 'orange' | 'purple'][] = [
  ['photo', 'Фото', 'image', 'blue'], ['video', 'Видео', 'video', 'purple'], ['file', 'Файлы', 'file', 'orange'],
];

/** «Данные и память»: автозагрузка медиа (на устройстве), занятое место, очистка кэша и локальных данных. */
export function Data() {
  const al = useGlobal((s) => s.prefs.autoload);
  const media = useGlobal((s) => s.prefs.media);
  const chats = useGlobal((s) => s.chats.length);
  const status = useGlobal((s) => s.status);
  const scroll = useScrollMemory('settings/data');
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [ask, setAsk] = useState<'cache' | 'local' | 'autoload' | null>(null);
  const [lastAsk, setLastAsk] = useState<'cache' | 'local' | 'autoload'>('cache');   // текст диалога держится на время закрытия
  const [busy, setBusy] = useState(false);
  const [unsent, setUnsent] = useState(0);   // сообщения (в очереди и с ошибкой) и правки, не дошедшие до сервера
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const skeleton = useMinVisible(info == null, { delay: 150, min: 600 });
  const def = defaultPrefs().autoload;
  const isDef = isDefaultAutoload(al, def);

  // размер и строки базы приходят вместе — строка списка появляется сразу целой; прежние строки держим до нового ответа
  const recompute = () => {
    void Promise.all([readStorage(), within(storageStats().then((s) => s.rows), ROWS_WAIT_MS)])
      .then(([i, rows]) => { if (alive.current) setInfo((prev) => ({ ...i, rows: rows ?? prev?.rows })); })
      .catch(() => { if (alive.current) setInfo((prev) => ({ used: 0, quota: 0, db: 0, media: 0, exact: false, approx: false, rows: prev?.rows })); });
  };
  useEffect(recompute, []);
  // после смены срока или лимита SW чистит кэш сам — пересчитываем занятое, когда он закончит
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settle = () => { if (settleTimer.current) clearTimeout(settleTimer.current); settleTimer.current = setTimeout(recompute, 1200); };
  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current); }, []);
  const open = (k: 'cache' | 'local' | 'autoload') => { if (k === 'local') setUnsent(status.outbox + status.failed + getPendingOps()); setLastAsk(k); setAsk(k); };

  const clearCache = async () => {
    setAsk(null);
    try { await clearMediaCaches(); showToast('Кэш медиа очищен'); } catch { showToast('Не удалось очистить кэш'); }
    recompute();
  };
  const clearLocal = async (keepOutbox: boolean) => {
    setAsk(null);
    if (busy) return;
    setBusy(true);
    try {
      await resetLocal(keepOutbox);
      void go('chats');   // список покажет скелет, пока идёт снимок
    } catch { showToast('Не удалось очистить данные, попробуйте ещё раз'); }
    if (alive.current) { setBusy(false); recompute(); }
  };

  const pct = (n: number) => (info && info.quota > 0 ? Math.max(n > 0 ? 1 : 0, (n / info.quota) * 100) : 0);
  const n = unsent;
  const dialog = {
    cache: { title: 'Очистить кэш медиа?', text: 'Загруженные фото, видео и файлы удалятся с устройства. При необходимости они скачаются снова.', confirm: 'Очистить', run: clearCache },
    local: clearLocalDialog(n, (keep) => void clearLocal(keep)),
    autoload: { title: 'Сбросить настройки автозагрузки?', text: 'Для фото, видео и файлов вернутся значения по умолчанию.', confirm: 'Сбросить', run: () => { setAsk(null); setPrefs({ 'autoload.enabled': def.enabled, 'autoload.photo': def.photo, 'autoload.video': def.video, 'autoload.file': def.file, 'autoload.fileMaxMb': def.fileMaxMb }); } },
  }[lastAsk];
  const extra = lastAsk === 'local' ? clearLocalDialog(n, (keep) => void clearLocal(keep)).extra : undefined;

  return (
    <div class="rl-sidepage" aria-label="Данные и память">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Данные и память" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section title="Автозагрузка медиа" footer="Настройки действуют на этом устройстве.">
          <InfoRow setting="data.autoload" tile="green" icon="download" title="Автозагрузка медиа" trailing={<Switch id="al-master" label="Автозагрузка медиа" checked={al.enabled} onChange={(e: Event) => setPrefs({ 'autoload.enabled': (e.currentTarget as HTMLInputElement).checked })} />} />
          {KINDS.map(([k, title, icon, tile]) => (
            <div key={k} class={al.enabled ? '' : 'app-dim'} aria-disabled={al.enabled ? undefined : 'true'} data-autoload={k}>
              <InfoRow tile={tile} icon={icon} title={title} subtitle={autoloadSubtitle(al, k)} onClick={al.enabled ? () => void go('settings/data/autoload/' + k) : undefined} />
            </div>
          ))}
        </Section>
        <Section>
          <div class={isDef ? 'app-dim' : ''} aria-disabled={isDef ? 'true' : undefined}>
            <InfoRow setting="data.autoload.reset" icon="history" title="Сбросить настройки автозагрузки" onClick={isDef ? undefined : () => open('autoload')} />
          </div>
        </Section>
        <Section setting="data.storage" title="Память">
          <div class="app-storage">
            <div class="app-storebar" role="img" aria-label={info ? `Занято ${formatBytes(info.used)} из ${formatBytes(info.quota)}` : 'Загрузка'}>
              <span class="app-store-db" style={{ width: pct(info?.db ?? 0) + '%' }} />
              <span class="app-store-media" style={{ width: pct(info?.media ?? 0) + '%' }} />
            </div>
            <div class="app-store-total">{info ? <><b>{formatBytes(info.used)}</b>{info.quota > 0 ? ' из ' + formatBytes(info.quota) : ''}</> : ' '}</div>
          </div>
          <div class="app-listwrap">
            <Presence show={skeleton} exitMs={280}>
              <div class="app-skel" aria-busy="true" aria-label="Загрузка">{[0, 1].map((i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}</div>
            </Presence>
            {info == null || skeleton ? null : (
              <>
                <InfoRow icon="chats" title={info.exact ? 'Чаты и сообщения' : 'Данные приложения'} subtitle={dbRowsLabel(info.rows)} value={formatBytes(info.db)} />
                <InfoRow icon="image" title="Медиа" subtitle={info.files ? `${filesLabel(info.files)} — открываются без сети` : undefined} value={(info.approx ? '≈ ' : '') + formatBytes(info.media)} />
                {info.savedFiles ? <InfoRow icon="download" title="Скачано вами" subtitle={`${filesLabel(info.savedFiles)} — сами не удаляются`} value={formatBytes(info.savedBytes ?? 0)} /> : null}
                {info.persisted === false ? <InfoRow icon="info" title="Хранилище не закреплено" subtitle="При нехватке места браузер может удалить данные Relay с устройства" /> : null}
              </>
            )}
          </div>
          <InfoRow icon="cloud" title="Чаты на устройстве" subtitle={`${chats} — доступны без сети`} />
          <InfoRow icon="history" title="Синхронизация" subtitle={status.phase === 'ready' ? (status.outbox ? `В очереди: ${status.outbox}` : 'Всё сохранено на сервере') : status.phase === 'offline' ? 'Ждём сеть' : 'Идёт обновление'} />
        </Section>
        <Section setting="data.cache" title="Кэш медиа" footer="Фото, видео и файлы, к которым давно не обращались, удаляются с устройства сами. При необходимости они скачаются снова. Скачанное кнопкой не удаляется — только очисткой ниже.">
          <RangeRow setting="data.cache.keep"
            label="Хранить медиа" min={0} max={KEEP_DAYS.length - 1} step={1} value={Math.max(0, KEEP_DAYS.indexOf(media.keepDays))}
            format={(i: number) => KEEP_LABEL[KEEP_DAYS[i]]}
            marks={KEEP_DAYS.map((d, i) => ({ value: i, label: KEEP_MARK[d] }))}
            onChange={(i: number) => { setPref('media.keepDays', KEEP_DAYS[i]); settle(); }}
          />
          <RangeRow setting="data.cache.max"
            label="Максимальный размер кэша" min={0} max={CACHE_MB.length - 1} step={1} value={Math.max(0, CACHE_MB.indexOf(media.maxMb))}
            format={(i: number) => mbLabel(CACHE_MB[i])}
            marks={CACHE_MB.map((m, i) => ({ value: i, label: m === 0 ? '∞' : mbLabel(m).replace(' ', '\u00a0') }))}
            onChange={(i: number) => { setPref('media.maxMb', CACHE_MB[i]); settle(); }}
          />
        </Section>
        <Section footer="Очистка локальных данных не удаляет ничего на сервере.">
          <InfoRow setting="data.clearCache" icon="trash" title="Очистить кэш медиа" onClick={() => open('cache')} />
          <InfoRow setting="data.clearLocal" icon="trash" danger title="Очистить локальные данные" onClick={busy ? undefined : () => open('local')} trailing={busy ? <span class="app-busy"><ProgressRing size={22} label="Очистка" /></span> : undefined} />
        </Section>
      </div>
      <ConfirmDialog open={ask != null} extra={extra} danger={lastAsk !== 'autoload'} title={dialog.title} text={dialog.text} confirm={dialog.confirm} cancel="Отмена" onCancel={() => setAsk(null)} onConfirm={() => void dialog.run()} />
    </div>
  );
}
