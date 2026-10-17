import { ChatRowSkeleton, ConfirmDialog, InfoRow, PanelHeader, Presence, Section, Switch, useMinVisible } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { autoloadSubtitle, isDefaultAutoload, type MediaKind } from '../../autoload';
import { useGlobal } from '../../global';
import { back, go } from '../../nav';
import { defaultPrefs, setPrefs } from '../../prefs';
import { resetLocal, showToast } from '../../settingsData';
import { clearMediaCaches, formatBytes, readStorage, type StorageInfo } from '../../storageInfo';
import { useScrollMemory } from '../useScrollMemory';

const KINDS: [MediaKind, string, string, 'blue' | 'orange' | 'purple'][] = [
  ['photo', 'Фото', 'image', 'blue'], ['video', 'Видео', 'video', 'purple'], ['file', 'Файлы', 'file', 'orange'],
];

/** «Данные и память»: автозагрузка медиа (на устройстве), занятое место, очистка кэша и локальных данных. */
export function Data() {
  const al = useGlobal((s) => s.prefs.autoload);
  const chats = useGlobal((s) => s.chats.length);
  const status = useGlobal((s) => s.status);
  const scroll = useScrollMemory('settings/data');
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [ask, setAsk] = useState<'cache' | 'local' | 'autoload' | null>(null);
  const [lastAsk, setLastAsk] = useState<'cache' | 'local' | 'autoload'>('cache');   // текст диалога держится на время закрытия
  const [busy, setBusy] = useState(false);
  const skeleton = useMinVisible(info == null, { delay: 150, min: 600 });
  const def = defaultPrefs().autoload;
  const isDef = isDefaultAutoload(al, def);

  const recompute = () => { void readStorage().then(setInfo).catch(() => setInfo({ used: 0, quota: 0, db: 0, media: 0 })); };
  useEffect(recompute, []);
  const open = (k: 'cache' | 'local' | 'autoload') => { setLastAsk(k); setAsk(k); };

  const clearCache = async () => {
    setAsk(null);
    try { await clearMediaCaches(); showToast('Кэш медиа очищен'); } catch { showToast('Не удалось очистить кэш'); }
    recompute();
  };
  const clearLocal = async () => {
    setAsk(null);
    if (busy) return;
    setBusy(true);
    try {
      await resetLocal(status.outbox === 0);   // неотправленное оставляем, пока пользователь не согласился его потерять
      void go('chats');   // список покажет скелет, пока идёт снимок
    } catch { showToast('Не удалось очистить данные'); }
    setBusy(false);
    recompute();
  };

  const pct = (n: number) => (info && info.quota > 0 ? Math.max(n > 0 ? 1 : 0, (n / info.quota) * 100) : 0);
  const lost = status.outbox;
  const dialog = {
    cache: { title: 'Очистить кэш медиа?', text: 'Загруженные фото, видео и файлы удалятся с устройства. При необходимости они скачаются снова.', confirm: 'Очистить', run: clearCache },
    local: lost > 0
      ? { title: 'Очистить локальные данные?', text: `${lost} ${lost === 1 ? 'сообщение ещё не отправлено' : 'сообщений ещё не отправлены'} — они будут потеряны. Чаты загрузятся с сервера заново.`, confirm: 'Очистить', run: clearLocal }
      : { title: 'Очистить локальные данные?', text: 'Чаты и сообщения на устройстве удалятся и загрузятся с сервера заново. Всё отправлено — ничего не потеряется.', confirm: 'Очистить', run: clearLocal },
    autoload: { title: 'Сбросить настройки автозагрузки?', text: 'Для фото, видео и файлов вернутся значения по умолчанию.', confirm: 'Сбросить', run: () => { setAsk(null); setPrefs({ 'autoload.enabled': def.enabled, 'autoload.photo': def.photo, 'autoload.video': def.video, 'autoload.file': def.file, 'autoload.fileMaxMb': def.fileMaxMb }); } },
  }[lastAsk];

  return (
    <div class="rl-sidepage" aria-label="Данные и память">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Данные и память" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section title="Автозагрузка медиа" footer="Настройки действуют на этом устройстве.">
          <InfoRow tile="green" icon="download" title="Автозагрузка медиа" trailing={<Switch id="al-master" label="Автозагрузка медиа" checked={al.enabled} onChange={(e: Event) => setPrefs({ 'autoload.enabled': (e.currentTarget as HTMLInputElement).checked })} />} />
          {KINDS.map(([k, title, icon, tile]) => (
            <div key={k} class={al.enabled ? '' : 'app-dim'} aria-disabled={al.enabled ? undefined : 'true'} data-autoload={k}>
              <InfoRow tile={tile} icon={icon} title={title} subtitle={autoloadSubtitle(al, k)} onClick={al.enabled ? () => void go('settings/data/autoload/' + k) : undefined} />
            </div>
          ))}
        </Section>
        <Section>
          <div class={isDef ? 'app-dim' : ''} aria-disabled={isDef ? 'true' : undefined}>
            <InfoRow icon="history" title="Сбросить настройки автозагрузки" onClick={isDef ? undefined : () => open('autoload')} />
          </div>
        </Section>
        <Section title="Память">
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
                <InfoRow icon="chats" title="Чаты и сообщения" value={formatBytes(info.db)} />
                <InfoRow icon="image" title="Медиа" value={formatBytes(info.media)} />
              </>
            )}
          </div>
          <InfoRow icon="cloud" title="Чаты на устройстве" subtitle={`${chats} — доступны без сети`} />
          <InfoRow icon="history" title="Синхронизация" subtitle={status.phase === 'ready' ? (status.outbox ? `В очереди: ${status.outbox}` : 'Всё сохранено на сервере') : status.phase === 'offline' ? 'Ждём сеть' : 'Идёт обновление'} />
        </Section>
        <Section footer="Очистка локальных данных не удаляет ничего на сервере.">
          <InfoRow icon="trash" title="Очистить кэш медиа" onClick={() => open('cache')} />
          <InfoRow icon="trash" danger title="Очистить локальные данные" onClick={() => open('local')} />
        </Section>
      </div>
      <ConfirmDialog open={ask != null} danger={lastAsk !== 'autoload'} title={dialog.title} text={dialog.text} confirm={dialog.confirm} cancel="Отмена" onCancel={() => setAsk(null)} onConfirm={() => void dialog.run()} />
    </div>
  );
}
