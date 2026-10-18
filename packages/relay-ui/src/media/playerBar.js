// Плеер под шапкой чата (как в Telegram Web A): ‹‹ ▶/❚❚ ›› · кто и «Голосовое сообщение · 0:07» · скорость · ×.
// Скорость: нажатие — 1× ↔ последняя быстрая, правая кнопка / долгое нажатие — список из пяти.
// Появляется выездом сверху с затуханием; тонкая полоска прогресса снизу пишется в DOM на каждый кадр.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, IconButton, Icon, Presence } from '../kit.js';
import { Menu } from '../more.js';
import * as player from './player.js';

function fmt(sec) { sec = Math.max(0, Math.floor(sec || 0)); return Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60); }
function labelOf(rate) { var s = player.SPEEDS.filter(function (x) { return x.rate === rate; })[0]; return s ? s.label : rate + 'X'; }

export function PlayerBar() {
  var st = useState(player.playerState()), s = st[0];
  var last = useRef(s.track);
  if (s.track) last.current = s.track;   // уезжая, полоса показывает последний трек
  var menu = useState(false);
  var line = useRef(null), clock = useRef(null);
  useEffect(function () {
    var off = player.subscribe(function (n) { st[1](n); });
    var offTick = player.onTick(function (k, t, d) {
      if (line.current) line.current.style.transform = 'scaleX(' + (d ? Math.min(1, t / d) : 0) + ')';
      if (clock.current) { var text = fmt(t); if (clock.current.textContent !== text) clock.current.textContent = text; }
    });
    return function () { off(); offTick(); };
  }, []);
  var t = last.current;
  return h(Presence, { show: !!s.track, exitMs: 300 },
    t ? h('div', { class: 'rl-playerbar', role: 'region', 'aria-label': 'Плеер' },
      h(IconButton, { icon: 'chevronLeft', label: 'Предыдущее', size: 20, class: cx(!player.hasStep(-1) && 'rl-playerbar-off'), onClick: function () { player.step(-1); } }),
      h('button', { type: 'button', class: cx('rl-playerbar-play', s.playing && 'rl-vb-playing'), 'aria-label': s.playing ? 'Пауза' : 'Воспроизвести', onClick: function () { if (s.playing) player.pause(); else player.play(t); } },
        h(Icon, { name: 'play', size: 20, class: 'rl-vb-play' }), h(Icon, { name: 'pause', size: 20, class: 'rl-vb-pause' })),
      h(IconButton, { icon: 'chevronRight', label: 'Следующее', size: 20, class: cx(!player.hasStep(1) && 'rl-playerbar-off'), onClick: function () { player.step(1); } }),
      h('div', { class: 'rl-playerbar-text' },
        h('b', null, t.title || 'Голосовое сообщение'),
        h('span', null, t.subtitle || '', ' · ', h('span', { ref: clock }, fmt(s.time)))),
      h('div', { class: 'rl-playerbar-speed-wrap' },
        h('button', { type: 'button', class: cx('rl-playerbar-speed', s.rate !== 1 && 'rl-playerbar-speed-on'), 'aria-label': 'Скорость ' + labelOf(s.rate),
          onClick: function () { player.toggleFast(); },
          onContextMenu: function (e) { e.preventDefault(); menu[1](true); } }, s.rate === 1 ? labelOf(s.fast) : labelOf(s.rate)),
        menu[0] ? h('div', { class: 'rl-playerbar-menu' },
          h('div', { class: 'rl-recmode-scrim', onClick: function () { menu[1](false); } }),
          h(Menu, { label: 'Скорость', onClose: function () { menu[1](false); }, items: player.SPEEDS.map(function (x) {
            return { icon: x.rate === s.rate ? 'check' : undefined, label: x.label, onClick: function () { menu[1](false); player.setRate(x.rate); } };
          }) })) : null),
      h(IconButton, { icon: 'close', label: 'Закрыть плеер', size: 20, onClick: function () { player.close(); } }),
      h('i', { ref: line, class: 'rl-playerbar-line', 'aria-hidden': 'true' })) : null);
}
