import type { UserPhoto } from '@relay/protocol';
import { confirmModal, MediaViewer } from '@relay/ui';
import { removeProfilePhoto, setMainPhoto } from '../profilePhoto';
import { showToast } from '../settingsData';
import { fullDateTime } from './format';

/**
 * Просмотр фото профиля: те же полёт из шапки/аватарки и листание, что у медиа; вверху — «Фото 2 из 5 · дата».
 * Видео-аватарка играет по кругу без звука. Свои фото (own): «Сделать основным» (кроме главного) и «Удалить».
 */
export function PhotoViewer({ photos, index, name, own, onIndex, onClose, origin }: {
  photos: UserPhoto[]; index: number; name: string; own?: boolean;
  onIndex?: (i: number) => void; onClose: () => void; origin?: (k: number) => HTMLElement | null;
}) {
  const n = photos.length;
  const items = photos.map((p, k) => ({
    src: `/files/${p.id}`, thumb: p.thumb, w: 640, h: 640, name: `photo-${p.pid || k}.jpg`,
    ...(p.video ? { video: `/files/${p.video}` } : {}),
    sender: name,
    avatar: { src: `/files/${p.small}`, thumb: p.thumb },
    date: (n > 1 ? `Фото ${k + 1} из ${n} · ` : '') + fullDateTime(new Date(p.at).toISOString()),
  }));
  const actions = own ? (_it: unknown, k: number) => {
    const p = photos[k];
    if (!p) return [];
    const main = k === 0;   // главное — всегда первым в истории
    return [
      ...(main ? [] : [{ icon: 'checkCircle', label: 'Сделать основным', onClick: () => { void setMainPhoto(p.pid).then(() => showToast('Фото стало основным'), () => showToast('Не удалось')); } }]),
      { icon: 'trash', label: 'Удалить', danger: true, onClick: () => {
        void confirmModal({ title: 'Удалить фото?', text: main ? 'Основным станет следующее фото.' : 'Фото пропадёт из профиля.', confirm: 'Удалить', danger: true })
          .then((ok) => { if (ok) void removeProfilePhoto(p.pid).catch(() => showToast('Не удалось удалить фото')); });
      } },
    ];
  } : () => [];   // чужие фото: только «скачать» и «закрыть», без действий над сообщением
  return <MediaViewer items={items} index={index} origin={origin} onIndex={onIndex} onClose={onClose} actions={actions} />;
}
