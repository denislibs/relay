// Сообщение из одних эмодзи — как в Telegram: без пузыря и хвоста. Один эмодзи из анимированного набора —
// стикер 112 px, играет один раз и замирает, клик — заново; иначе (2–7, больше или нет анимации) — крупные
// глифы по таблице размеров. Время — плашкой в правом нижнем углу; ответ, автор и пересылка — маленьким
// пузырём над ним; реакции — под ним (как у стикера).
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { cx, MsgLine, ForwardTitle, ReplyQuote, ReactionChips, MessageStatus } from './kit.js';
import { StickerView } from './StickerView.js';

export const EMOJI_STICKER_PX = 112;

/** Размер глифа по числу эмодзи (Telegram: 112, 90, 84, 72, 60, 48, 36; больше семи — 36). */
export function emojiFontSize(count) {
  return [0, 112, 90, 84, 72, 60, 48][count] || 36;
}

/**
 * props: text, count (размер сетки), src (адрес анимации одного эмодзи или null), from, groupStart, appear, aside,
 * fwd, author, authorTone, reply, time, status, metaBefore, footer, reactions, onReact.
 */
export function EmojiBubble(props) {
  const out = props.from === 'out';
  const head = props.fwd || props.author || props.reply;
  const [replay, setReplay] = useState(0);
  const animated = props.count === 1 && !!props.src;
  const size = emojiFontSize(props.count);
  return h(MsgLine, { aside: props.aside, class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-sticker-msg rl-emoji-msg', out ? 'rl-sticker-msg-out' : 'rl-sticker-msg-in', props.appear && (out ? 'rl-appear-out' : 'rl-appear-in')) },
      head ? h('div', { class: cx('rl-sticker-head', out && 'rl-sticker-head-out') },
        props.fwd ? h(ForwardTitle, { fwd: props.fwd }) : null,
        props.author && !props.fwd ? h('span', { class: 'rl-bubble-author', style: { color: 'var(--peer-' + (props.authorTone != null ? props.authorTone : 5) + ')' } }, props.author) : null,
        props.reply ? h(ReplyQuote, Object.assign({ inBubble: true }, props.reply)) : null) : null,
      h('div', { class: cx('rl-sticker-box', !animated && 'rl-emoji-box') },
        animated
          ? h(StickerView, { src: props.src, w: 512, h: 512, size: EMOJI_STICKER_PX, group: 'feed', loop: false, replay, title: props.text,
            onClick: (e) => { e.stopPropagation(); setReplay((n) => n + 1); if (props.onClick) props.onClick(e); } })
          : h('span', { class: 'rl-emoji-text', style: { fontSize: size + 'px' } }, props.text),
        h('span', { class: 'rl-media-chip rl-sticker-meta' }, props.metaBefore ? props.metaBefore() : null, props.time, out || props.status ? h(MessageStatus, { status: props.status || 'read' }) : null)),
      props.footer ? h('div', { class: 'rl-footer-plate' }, props.footer) : null,
      props.reactions && props.reactions.length ? h(ReactionChips, { items: props.reactions, out, float: true, onClick: props.onReact }) : null));
}
