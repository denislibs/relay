// Музыка в ленте — как в Telegram Web A: круглая кнопка 48 px (play ↔ pause), название, под ним
// «длительность • размер»; пока играет — «прошло / всего» и полоса, по которой можно перематывать.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon, MessageStatus, ProgressRing } from '../kit.js';
import * as player from './player.js';

function fmt(sec) { sec = Math.max(0, Math.floor(sec || 0)); return Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60); }

export function MusicBubble(props) {
  var out = props.from === 'out';
  var st = useState(player.playerState()), s = st[0];
  var bar = useRef(null), clock = useRef(null);
  var mine = s.key === props.trackKey;
  useEffect(function () {
    var off = player.subscribe(function (n) { st[1](n); });
    var offTick = player.onTick(function (k, t, d) {
      if (k !== props.trackKey) return;
      if (bar.current) bar.current.style.transform = 'scaleX(' + (d ? Math.min(1, t / d) : 0) + ')';
      if (clock.current) { var x = fmt(t); if (clock.current.textContent !== x) clock.current.textContent = x; }
    });
    return function () { off(); offTick(); };
  }, [props.trackKey]);
  var playing = mine && s.playing;
  function seekAt(e) {
    var r = e.currentTarget.getBoundingClientRect();
    if (r.width) player.seek(props.trackKey, (e.clientX - r.left) / r.width);
  }
  return h('div', { class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && 'rl-msgline-gap') },
    h('div', { class: cx('rl-bubble', out ? 'rl-bubble-out' : 'rl-bubble-in', props.tail && 'rl-bubble-tail', 'rl-music') },
      h('div', { class: 'rl-music-row' },
        props.uploading
          ? h(ProgressRing, { size: 48, progress: props.progress, onMedia: false, onCancel: props.onCancel, label: 'Отправка' })
          : h('button', { type: 'button', class: cx('rl-music-play', playing && 'rl-vb-playing'), 'aria-label': playing ? 'Пауза' : 'Слушать',
              onClick: function (e) { e.stopPropagation(); if (props.onToggle) props.onToggle(); } },
            h(Icon, { name: 'play', size: 24, class: 'rl-vb-play' }), h(Icon, { name: 'pause', size: 24, class: 'rl-vb-pause' })),
        h('div', { class: 'rl-music-text' },
          h('b', { title: props.title }, props.title),
          mine
            ? h('div', { class: 'rl-music-live' },
              h('span', null, h('span', { ref: clock }, fmt(s.time)), ' / ', fmt(props.duration)),
              h('div', { class: 'rl-music-seek', onClick: seekAt }, h('i', { ref: bar })))
            : h('span', null, fmt(props.duration), props.performer ? ' • ' + props.performer : props.size ? ' • ' + props.size : ''))),
      h('span', { class: 'rl-music-meta' }, props.time, out ? h(MessageStatus, { status: props.status || 'sent' }) : null)));
}
