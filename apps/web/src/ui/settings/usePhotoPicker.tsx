import { AvatarCropper } from '@relay/ui';
import type { ProfilePhoto } from '@relay/protocol';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { avatarPhoto, removeProfilePhoto, setProfilePhoto } from '../../profilePhoto';
import { showToast } from '../../settingsData';

/**
 * Своё фото профиля: выбор файла → обрезка по кругу → загрузка. Пока сервер не подтвердил, аватар показывает
 * обрезанное (а не старое фото и не инициалы); ошибка — тост и возврат как было.
 * avatar — пропсы для ProfileHeader/Avatar, ui — скрытый input и окно обрезки (вставить в разметку).
 */
export function usePhotoPicker(photo: ProfilePhoto | null | undefined) {
  const input = useRef<HTMLInputElement>(null);
  const [crop, setCrop] = useState<{ src: string; kind: 'image' | 'video' | 'gif' } | null>(null);
  const [local, setLocal] = useState<{ src: string; thumb: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { if (crop) URL.revokeObjectURL(crop.src); }, [crop]);
  // сервер подтвердил и фото пришло в профиль — своё превью больше не нужно
  useEffect(() => { if (!busy && local) { const s = local.src; setLocal(null); setTimeout(() => URL.revokeObjectURL(s), 2000); } }, [photo?.id]);

  const chosen = (e: Event) => {
    const el = e.currentTarget as HTMLInputElement, f = el.files?.[0];
    el.value = '';   // тот же файл ещё раз — снова change
    if (!f) return;
    const kind = f.type === 'image/gif' ? 'gif' : /^video\//.test(f.type) ? 'video' : /^image\//.test(f.type) ? 'image' : null;
    if (!kind) { showToast('Нужна картинка, GIF или видео'); return; }
    setCrop({ src: URL.createObjectURL(f), kind });
  };
  const cropped = (c: { big: Blob; small: Blob; thumb: string; video?: { blob: Blob; side: number; duration: number } }) => {
    setCrop(null);
    const src = URL.createObjectURL(c.big);
    setLocal({ src, thumb: c.thumb });
    setBusy(true);
    setProfilePhoto(c).then(() => setBusy(false), () => { setBusy(false); setLocal(null); URL.revokeObjectURL(src); showToast('Не удалось загрузить фото'); });
  };
  const remove = () => {
    setLocal(null); setBusy(true);
    removeProfilePhoto().then(() => setBusy(false), () => { setBusy(false); showToast('Не удалось удалить фото'); });
  };

  const ui: JSX.Element = (
    <>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,video/mp4,video/webm,video/quicktime" hidden onChange={chosen} />
      {crop ? <AvatarCropper src={crop.src} kind={crop.kind} onClose={() => setCrop(null)} onDone={cropped} onError={() => { setCrop(null); showToast('Не получилось обработать фото'); }} /> : null}
    </>
  );
  return {
    avatar: { ...(local ?? avatarPhoto(photo, true)), busy, avatarLabel: photo ? 'Сменить фото' : 'Поставить фото', onAvatar: busy ? undefined : () => input.current?.click() },
    pick: () => input.current?.click(), remove, busy, has: !!(photo || local), ui,
  };
}
