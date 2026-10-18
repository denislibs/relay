// Музыка в ленте — как в Telegram: круглая кнопка 48 px (обложка из тегов файла, поверх — play/pause),
// в углу — значок «скачать»; справа название и «2:50 • исполнитель». Пока играет — «прошло / всего» и полоса перемотки.
// Файлы, отправленные вместе, — один пузырь: pos first/middle/last склеивает строки, время — только у последней.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, ForwardTitle, Icon, MessageStatus, ProgressRing } from '../kit.js';
import * as player from './player.js';

// треки, которые включали в этой вкладке: файл уже качается в кэш — значок «скачать» в углу не нужен (как в Telegram).
// После перезагрузки то же скажет props.downloaded (файл есть в кэше)
var heard = new Set();

function fmt(sec) { sec = Math.max(0, Math.floor(sec || 0)); return Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60); }

export function MusicBubble(props) {
  var out = props.from === 'out';
  var pos = props.pos || 'single';
  var st = useState(player.playerState()), s = st[0];
  var bar = useRef(null), knob = useRef(null), clock = useRef(null);
  var mine = s.key === props.trackKey;
  useEffect(function () {
    var off = player.subscribe(function (n) { st[1](n); });
    var offTick = player.onTick(function (k, t, d) {
      if (k !== props.trackKey) return;
      var f = d ? Math.min(1, t / d) : 0;
      if (bar.current) bar.current.style.transform = 'scaleX(' + f + ')';
      if (knob.current) knob.current.style.transform = 'translateX(' + (f * 100) + '%)';
      if (clock.current) { var x = fmt(t); if (clock.current.textContent !== x) clock.current.textContent = x; }
    });
    return function () { off(); offTick(); };
  }, [props.trackKey]);
  var playing = mine && s.playing;
  if (mine) heard.add(props.trackKey);
  var showDl = !props.uploading && !!props.onDownload && !props.downloaded && !heard.has(props.trackKey);
  var last = pos === 'single' || pos === 'last';
  function seekAt(e) {
    var r = e.currentTarget.getBoundingClientRect();
    if (r.width) player.seek(props.trackKey, (e.clientX - r.left) / r.width);
  }
  return h('div', { class: cx('rl-msgline', out && 'rl-msgline-out', props.groupStart && pos !== 'middle' && pos !== 'last' && 'rl-msgline-gap', 'rl-music-line', 'rl-music-' + pos) },
    h('div', { class: cx('rl-bubble', out ? 'rl-bubble-out' : 'rl-bubble-in-side', props.tail && last && 'rl-bubble-tail', 'rl-music') },
      props.fwd ? h(ForwardTitle, { fwd: props.fwd }) : null,
      h('div', { class: 'rl-music-row' },
        h('div', { class: 'rl-music-btnwrap' },
          props.uploading
            ? h(ProgressRing, { size: 48, progress: props.progress, onMedia: true, onCancel: props.onCancel, label: 'Отправка' })
            : h('button', { type: 'button', class: cx('rl-music-play', playing && 'rl-vb-playing', props.cover && 'rl-music-cover'),
                style: props.cover ? { backgroundImage: 'url(' + props.cover + ')' } : undefined,
                'aria-label': playing ? 'Пауза' : 'Слушать', onClick: function (e) { e.stopPropagation(); if (props.onToggle) props.onToggle(); } },
              h(Icon, { name: 'play', size: 24, class: 'rl-vb-play' }), h(Icon, { name: 'pause', size: 24, class: 'rl-vb-pause' })),
          !props.uploading && props.onDownload ? h('button', { type: 'button', class: cx('rl-music-dl', !showDl && 'rl-music-dl-gone'), 'aria-label': 'Скачать',
            tabIndex: showDl ? undefined : -1, 'aria-hidden': showDl ? undefined : 'true',
            onClick: function (e) { e.stopPropagation(); props.onDownload(); } }, h(Icon, { name: 'download', size: 12 })) : null),
        h('div', { class: 'rl-music-text' },
          h('b', { title: props.title }, props.title),
          mine
            // как в Telegram: при воспроизведении вторая строка — время и полоса с бегунком, той же высоты, что «длительность • исполнитель»
            ? h('div', { class: 'rl-music-live' },
              h('span', { class: 'rl-music-sub', ref: clock }, fmt(s.time)),
              h('div', { class: 'rl-music-seek', onClick: seekAt }, h('i', { ref: bar }), h('span', { class: 'rl-music-knob', ref: knob }, h('b', null))))
            : h('span', { class: 'rl-music-sub' }, fmt(props.duration), props.performer ? ' • ' + props.performer : props.size ? ' • ' + props.size : ''))),
      last ? h('span', { class: 'rl-music-meta' }, props.time, out ? h(MessageStatus, { status: props.status || 'sent' }) : null) : null));
}
