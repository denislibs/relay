import { FileBubble, MediaPolicy } from '@relay/ui';
import type { ComponentProps } from 'preact';
import { useContext, useEffect } from 'preact/hooks';
import { cancelDownload, getDownload, startDownload, useDownload, type DownloadFile } from '../downloads';
import { getPrefs } from '../prefs';
import { formatBytes } from '../storageInfo';

type BubbleProps = ComponentProps<typeof FileBubble>;

/**
 * Документ в ленте с менеджером загрузок: «скачать» — частями с кольцом и ×, готово — отдаём файл и храним его
 * на устройстве (квадрат с расширением — «открыть», мгновенно и без сети). Автозагрузка — по настройкам
 * «Данные и память» (файлы до N МБ, по видам чатов). Отправка (upload) — как раньше, её состояние даёт лента.
 */
export function FileMessage({ file, out, uploading, upload, ...rest }: BubbleProps & {
  file: DownloadFile; out: boolean;
  /** своё неотправленное: кольцо отправки (progress) / «повторить» */
  uploading: boolean; upload: 'failed' | 'loading' | null;
}) {
  const dl = useDownload(file.id || undefined);
  const policy = useContext(MediaPolicy) as { file?: boolean; fileMaxMb?: number } | null;
  const maxMb = getPrefs().media.maxMb;

  // автозагрузка входящего файла, если влезает в лимит настроек: молча в кэш, без сохранения на диск
  useEffect(() => {
    if (!file.id || out || !policy?.file || !(file.size <= (policy.fileMaxMb ?? 0) * 1024 * 1024)) return;
    if (getDownload(file.id).status === 'idle') void startDownload(file, { maxMb });
  }, [file.id, policy?.file, policy?.fileMaxMb]);

  if (upload || uploading || !file.id) return <FileBubble {...rest} state={upload ?? 'loading'} />;

  const loading = dl.status === 'loading';
  const meta = loading
    ? (dl.waiting ? 'Ожидание сети…' : `${formatBytes(dl.loaded)} из ${formatBytes(dl.total || file.size)}`)
    : dl.status === 'error' ? 'Не удалось скачать — нажмите, чтобы повторить' : rest.meta;
  return (
    <FileBubble {...rest} meta={meta}
      state={loading ? 'loading' : dl.status === 'done' ? 'ready' : 'remote'}
      progress={loading ? (dl.total ? dl.loaded / dl.total : 0) : undefined}
      onCancel={() => cancelDownload(file.id)}
      onDownload={() => void startDownload(file, { save: true, maxMb })}
      onOpen={() => void startDownload(file, { save: true, maxMb })}
    />
  );
}
