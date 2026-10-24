import type { StickerRef } from '@relay/protocol';
import { StickerView, stickerMsgSize } from '@relay/ui';

// Пустой личный чат — как в Telegram: плашка по центру ленты с текстом и стикером-приветствием.
// Нажатие на стикер отправляет его первым сообщением; карточка гаснет, а стикер «перелетает» в пузырь (Feed).
// Размер — как у стикера в ленте: у карточки и пузыря один плеер анимации (url|px), подмена после полёта бесшовна.

export function GreetingCard({ sticker, onSend }: { sticker: StickerRef | null; onSend: (s: StickerRef, from: HTMLElement) => void }) {
  return (
    <div class="app-greeting" role="note">
      <div class="app-greeting-card">
        <b class="app-greeting-title">Сообщений пока нет…</b>
        <span class="app-greeting-text">Напишите что-нибудь или отправьте приветствие ниже.</span>
        {sticker ? (
          <button type="button" class="app-greeting-sticker" aria-label={'Отправить приветствие' + (sticker.emoji ? ' ' + sticker.emoji : '')}
            onClick={(e) => onSend(sticker, e.currentTarget.firstElementChild as HTMLElement)}>
            <StickerView src={sticker.url} outline={sticker.outline} w={sticker.w} h={sticker.h} size={stickerMsgSize()} group="feed" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
