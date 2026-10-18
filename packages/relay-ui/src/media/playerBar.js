// Плеер над шапкой чата — отдельный остров, как в Telegram Web A: шапка уезжает вниз, пока он открыт,
// и он не пропадает при смене чата (состояние — в player.js, один на приложение).
// Музыка: ‹‹ ▶ ›› · название и «0:12 • исполнитель» · в профиль · плейлист · громкость · порядок · ×.
// Голосовое: ‹‹ ▶ ›› · кто и «Голосовое сообщение · 0:07» · громкость · скорость · ×. Снизу — тонкая полоска, по ней можно перематывать.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, IconButton, Icon, Presence } from '../kit.js';
import { Menu } from '../more.js';
import * as player from './player.js';

function fmt(sec) { sec = Math.max(0, Math.floor(sec || 0)); return Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60); }
function labelOf(rate) { var s = player.SPEEDS.filter(function (x) { return x.rate === rate; })[0]; return s ? s.label : rate + 'X'; }

export var ORDER_INFO = {
  all: { icon: 'repeat', label: 'Повторять плейлист' },
  one: { icon: 'repeatOne', label: 'Повторять трек' },
  shuffle: { icon: 'shuffle', label: 'Перемешать' },
  off: { icon: 'order', label: 'По порядку' },
};

/**
 * props: onTitle(track) — к сообщению; onPlaylist() — окно плейлиста; inProfile(track) / onToggleProfile(track) — музыка в профиле.
 */
export function PlayerBar(props) {
  var st = useState(player.playerState()), s = st[0];
  var last = useRef(s.track);
  if (s.track) last.current = s.track;   // уезжая, полоса показывает последний трек
  var menu = useState(null);             // 'speed' | 'order' | null
  var vol = useState(false);
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
  var music = !!(t && t.kind === 'music');
  var closeMenu = function () { menu[1](null); };
  function seekAt(e) {
    var r = e.currentTarget.getBoundingClientRect();   // клик — событие, не фаза записи
    if (t && r.width) player.seek(t.key, (e.clientX - r.left) / r.width);
  }
  var volIcon = s.muted || s.volume === 0 ? 'soundOff' : s.volume < 0.5 ? 'volumeLow' : 'volume';
  var inProfile = music && props.inProfile ? props.inProfile(t) : false;
  return h(Presence, { show: !!s.track, exitMs: 300 },
    t ? h('div', { class: 'rl-playerslot' }, h('div', { class: 'rl-playerclip' }, h('div', { class: 'rl-playerbar', role: 'region', 'aria-label': 'Плеер' },
      h(IconButton, { icon: 'skipPrev', label: 'Предыдущее', size: 22, class: cx(!player.hasStep(-1) && 'rl-playerbar-off'), onClick: function () { player.step(-1); } }),
      h('button', { type: 'button', class: cx('rl-playerbar-play', s.playing && 'rl-vb-playing'), 'aria-label': s.playing ? 'Пауза' : 'Воспроизвести', onClick: function () { if (s.playing) player.pause(); else player.play(t); } },
        h(Icon, { name: 'play', size: 22, class: 'rl-vb-play' }), h(Icon, { name: 'pause', size: 22, class: 'rl-vb-pause' })),
      h(IconButton, { icon: 'skipNext', label: 'Следующее', size: 22, class: cx(!player.hasStep(1) && 'rl-playerbar-off'), onClick: function () { player.step(1); } }),
      h('button', { type: 'button', class: 'rl-playerbar-text', onClick: function () { if (props.onTitle) props.onTitle(t); } },
        h('b', null, t.title || 'Голосовое сообщение'),
        music
          ? h('span', null, h('span', { ref: clock }, fmt(s.time)), t.performer ? ' • ' + t.performer : '')
          : h('span', null, t.subtitle || '', ' · ', h('span', { ref: clock }, fmt(s.time)))),
      music && props.onToggleProfile ? h(IconButton, { icon: inProfile ? 'musicRemove' : 'musicAdd', label: inProfile ? 'Убрать из профиля' : 'Добавить в профиль', size: 22,
        onClick: function () { props.onToggleProfile(t); } }) : null,
      music && props.onPlaylist ? h(IconButton, { icon: 'list', label: 'Плейлист', size: 22, onClick: props.onPlaylist }) : null,
      // громкость: клик — без звука; наведение — вертикальный ползунок
      h('div', { class: 'rl-playerbar-vol', onMouseEnter: function () { vol[1](true); }, onMouseLeave: function () { vol[1](false); } },
        h(IconButton, { icon: volIcon, label: s.muted ? 'Включить звук' : 'Выключить звук', size: 22, onClick: function () { player.toggleMute(); } }),
        vol[0] ? h('div', { class: 'rl-playerbar-volpop' },
          h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: s.muted ? 0 : s.volume, 'aria-label': 'Громкость',
            onInput: function (e) { player.setVolume(Number(e.currentTarget.value)); } })) : null),
      music
        ? h('div', { class: 'rl-playerbar-speed-wrap' },
          h(IconButton, { icon: ORDER_INFO[s.order].icon, label: ORDER_INFO[s.order].label, size: 22, onClick: function () { menu[1](menu[0] === 'order' ? null : 'order'); } }),
          menu[0] === 'order' ? h('div', { class: 'rl-playerbar-menu' },
            h('div', { class: 'rl-recmode-scrim', onClick: closeMenu }),
            h(Menu, { label: 'Порядок', onClose: closeMenu, items: ['shuffle', 'all', 'one', 'off'].map(function (k) {
              return { icon: s.order === k ? 'check' : ORDER_INFO[k].icon, label: ORDER_INFO[k].label, onClick: function () { closeMenu(); player.setOrder(k); } };
            }) })) : null)
        : h('div', { class: 'rl-playerbar-speed-wrap' },
          h('button', { type: 'button', class: cx('rl-playerbar-speed', s.rate !== 1 && 'rl-playerbar-speed-on'), 'aria-label': 'Скорость ' + labelOf(s.rate),
            onClick: function () { player.toggleFast(); },
            onContextMenu: function (e) { e.preventDefault(); menu[1]('speed'); } }, s.rate === 1 ? labelOf(s.fast) : labelOf(s.rate)),
          menu[0] === 'speed' ? h('div', { class: 'rl-playerbar-menu' },
            h('div', { class: 'rl-recmode-scrim', onClick: closeMenu }),
            h(Menu, { label: 'Скорость', onClose: closeMenu, items: player.SPEEDS.map(function (x) {
              return { icon: x.rate === s.rate ? 'check' : undefined, label: x.label, onClick: function () { closeMenu(); player.setRate(x.rate); } };
            }) })) : null),
      h(IconButton, { icon: 'close', label: 'Закрыть плеер', size: 22, onClick: function () { player.close(); } }),
      h('div', { class: 'rl-playerbar-seek', onClick: seekAt, 'aria-hidden': 'true' }, h('i', { ref: line, class: 'rl-playerbar-line' }))))) : null);
}
