import { Icon, IconButton, Presence, plural, useMinVisible } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cancelPreparing, discardUnsent } from '../data';
import { useGlobal, type UploadItem } from '../global';
import { fileSize } from './format';

// Очередь отправки под шапкой — как в Telegram: «Отправка 3 файлов · 45%» с полоской общего прогресса;
// нажатие раскрывает список файлов, у каждого — ×. Загрузка идёт в общем воркере: смена чата и вкладки ей не мешает,
// а после перезагрузки очередь из IndexedDB продолжает сама — плашка снова появится.
// Без вспышек: появляется, только если отправка дольше 400 мс, и держится не меньше 700 мс (затем гаснет).

const KIND_ICON: Record<string, string> = { photo: 'image', video: 'video', audio: 'music', voice: 'mic', round: 'video' };

/** «Отправка фото», «Отправка 3 файлов»: один файл — по виду, несколько — числом. */
function label(list: UploadItem[]): string {
  const n = list.length;
  if (list.every((u) => u.compressing)) return n === 1 ? 'Сжатие видео' : `Сжатие ${n} видео`;
  if (n === 1) return list[0].kind === 'photo' ? 'Отправка фото' : list[0].kind === 'video' ? 'Отправка видео' : 'Отправка файла';
  return `Отправка ${n} ${plural(n, 'файла', 'файлов', 'файлов')}`;
}

/** Общий прогресс — по байтам: большой видеофайл весит больше фото рядом с ним. Пока что-то сжимается — прогресс сжатия. */
function total(list: UploadItem[]): number {
  let all = 0, done = 0;
  const only = list.every((u) => u.compressing);
  for (const u of list) { all += u.size || 1; done += (u.size || 1) * (u.compressing && !only ? 0 : u.progress); }
  return all ? done / all : 0;
}

export function UploadBar({ chatId }: { chatId: number }) {
  // сначала то, что ещё сжимается (вкладка), затем очередь движка
  const prep = useGlobal((s) => s.preparing.filter((u) => u.chatId === chatId));
  const queued = useGlobal((s) => s.uploads.filter((u) => u.chatId === chatId));
  const list = prep.length ? [...prep, ...queued] : queued;
  const show = useMinVisible(list.length > 0, { delay: 400, min: 700 });
  const [open, setOpen] = useState(false);
  // на уходе плашка гаснет с последним видом, а не с «Отправка 0 файлов»
  const last = useRef<UploadItem[]>(list);
  if (list.length) last.current = list;
  const shown = list.length ? list : last.current;
  useEffect(() => { if (!list.length) setOpen(false); }, [list.length > 0]);
  useEffect(() => setOpen(false), [chatId]);
  const p = Math.min(1, total(shown));
  const pct = Math.floor(p * 100);
  return (
    <Presence show={show} exitMs={180}>
      <div class={'app-upload-bar' + (open ? ' app-upload-bar-open' : '')}>
        <button type="button" class="app-upload-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="upload" size={18} />
          <span class="app-upload-label">{label(shown)}<span class="app-upload-pct"> · {pct}%</span></span>
          <Icon name={open ? 'chevronUp' : 'chevronDown'} size={18} />
          <span class="app-upload-track" aria-hidden="true"><span class="app-upload-fill" style={{ transform: `scaleX(${p})` }} /></span>
        </button>
        <Presence show={open} exitMs={140}>
          <ul class="app-upload-list" aria-label="Файлы в очереди отправки">
            {shown.map((u) => (
              <li key={u.key} class="app-upload-row">
                <Icon name={KIND_ICON[u.kind] ?? 'file'} size={18} />
                <span class="app-upload-name">{u.name}</span>
                <span class="app-upload-size">{u.compressing ? `сжатие ${Math.floor(u.progress * 100)}%` : u.uploaded ? 'ждёт отправки' : `${Math.floor(u.progress * 100)}% · ${fileSize(u.size)}`}</span>
                <IconButton icon="close" label={'Отменить отправку ' + u.name} onClick={() => (u.compressing ? cancelPreparing(u.key) : discardUnsent(u.key))} />
              </li>
            ))}
          </ul>
        </Presence>
      </div>
    </Presence>
  );
}
