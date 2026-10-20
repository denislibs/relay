/** @jsxImportSource preact */
import type { StickerRef, StickerSet } from '@relay/protocol';
import { Icon, IconButton, StickerView, openModal, setStickerGroupExclusive, useMinVisible } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { plural } from '../../groups';
import { showToast } from '../../settingsData';
import { installSet, loadStickerSet, sendStickerHere, useMyStickers } from '../../stickers';
import { StickerPreviewHold } from './StickerPreview';

/** Модалка пака: сетка (анимированы и зациклены), «Добавить / Удалить N стикеров»; пока открыта, остальное на паузе. */
export function showStickerSet(idOrShort: number | string): void {
  setStickerGroupExclusive('modal');
  openModal((close: () => void) => <SetBody id={idOrShort} close={close} />, {
    size: 'slim', header: null, label: 'Стикеры', class: 'app-stkset', bodyClass: 'app-stkset-body',
    onClose: () => setStickerGroupExclusive(null),
  });
}

const count = (n: number) => `${n} ${plural(n, 'стикер', 'стикера', 'стикеров')}`.toUpperCase();

function SetBody({ id, close }: { id: number | string; close: () => void }) {
  const [set, setSet] = useState<StickerSet | null | undefined>(undefined);   // undefined — грузится, null — нет такого
  const [busy, setBusy] = useState(false);
  const mine = useMyStickers();
  const loading = useMinVisible(set === undefined, { delay: 200, min: 400 });
  useEffect(() => {
    let live = true;
    loadStickerSet(id).then((s) => { if (live) setSet(s); }, () => { if (live) setSet(null); });
    return () => { live = false; };
  }, [id]);
  const installed = !!set && mine.sets.some((s) => s.id === set.id);
  const toggle = async () => {
    if (!set || busy) return;
    setBusy(true);
    try {
      await installSet(set.id, !installed, installed ? undefined : { id: set.id, shortName: set.shortName, title: set.title, kind: set.kind, count: set.count, cover: set.cover, hash: set.hash });
      showToast(installed ? 'Набор удалён' : 'Набор добавлен');
      close();
    } finally { setBusy(false); }
  };
  const copy = () => {
    if (!set) return;
    void navigator.clipboard?.writeText(`${location.origin}/addstickers/${set.shortName}`).then(() => showToast('Ссылка скопирована'), () => {});
  };
  const pick = (s: StickerRef) => { if (sendStickerHere(s)) close(); };
  return (
    <div class="app-stkset-wrap">
      <div class="app-stkset-head">
        <IconButton icon="close" label="Закрыть" onClick={close} />
        <h2>{set ? set.title : set === null ? 'Набор не найден' : loading ? 'Загрузка…' : ' '}</h2>
        {set ? <IconButton icon="link" label="Скопировать ссылку" onClick={copy} /> : <span class="app-stkset-gap" />}
      </div>
      <div class="app-stkset-grid" role="list">
        {set?.stickers.map((s) => (
          <StickerPreviewHold key={s.id} sticker={s}>
            <div class="app-stkset-cell" role="listitem">
              <StickerView src={s.url} outline={s.outline} w={s.w} h={s.h} size={72} group="modal" loop title={s.emoji} onClick={() => pick(s)} />
            </div>
          </StickerPreviewHold>
        ))}
      </div>
      {set ? (
        <button type="button" class={'app-stkset-pill' + (installed ? ' app-stkset-pill-danger' : '')} disabled={busy} onClick={toggle}>
          {installed ? 'УДАЛИТЬ ' : 'ДОБАВИТЬ '}{count(set.count)}
        </button>
      ) : null}
      {set === null ? <p class="app-stkset-empty"><Icon name="info" size={20} /> Пак удалён или переименован</p> : null}
    </div>
  );
}
