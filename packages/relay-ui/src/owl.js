import { h } from 'preact';

/*
 * Сова — персонаж экрана входа (своя графика Relay). Поведение как у «обезьяны» Telegram, рисунок свой:
 *  mode 'idle'  — смотрит на тебя, моргает и дышит;
 *  mode 'track' — следит за полем: gaze 0…1 — куда смотреть (первая клетка … последняя), голова чуть поворачивается;
 *  mode 'cover' — закрыла глаза крыльями (пароль); peek — правое крыло опускается, сова подглядывает.
 * Всё движение — CSS-переходы по transform: взгляд непрерывный, а не по кадрам; цвета — токены --owl-*.
 */

var EYES = [44, 76];
// крыло-«ладонь» поверх глаза, координаты вокруг центра глаза
var COVER = 'M-17 14C-19 2-16-10-8-16C-6-11-4-9-2-9C-1-15 3-18 7-17C7-12 9-10 11-10C13-14 17-14 19-11C20 0 16 12 6 17C-2 20-12 19-17 14Z';

function lerp(a, b, t) { return a + (b - a) * t; }

function Owl(props) {
  var mode = props.mode || 'idle';
  var size = props.size || 130;
  var gaze = Math.max(0, Math.min(1, props.gaze == null ? 0.5 : props.gaze));
  var tracking = mode === 'track';
  var px = tracking ? lerp(-5, 5, gaze) : 0;
  var py = tracking ? 3.5 : 0;
  var tilt = tracking ? lerp(-5, 5, gaze) : 0;

  return h('svg', {
    class: 'rl-owl rl-owl--' + mode + (props.peek ? ' rl-owl--peek' : '') + (props.class ? ' ' + props.class : ''),
    viewBox: '0 0 120 120', width: size, height: size, role: 'img', 'aria-hidden': 'true', focusable: 'false',
  },
    h('defs', null, EYES.map(function (cx, i) {
      return h('clipPath', { key: i, id: 'rl-owl-eye-' + i }, h('circle', { cx: cx, cy: 52, r: 13 }));
    })),
    h('ellipse', { class: 'rl-owl-shadow', cx: 60, cy: 113, rx: 30, ry: 4 }),
    h('g', { class: 'rl-owl-feet' },
      h('ellipse', { cx: 50, cy: 109, rx: 6, ry: 3 }),
      h('ellipse', { cx: 70, cy: 109, rx: 6, ry: 3 })),
    h('g', { class: 'rl-owl-head', style: { transform: 'rotate(' + tilt + 'deg)' } },
      h('g', { class: 'rl-owl-breath' },
        h('path', { class: 'rl-owl-tuft', d: 'M31 36L25 11L46 27Z' }),
        h('path', { class: 'rl-owl-tuft', d: 'M89 36L95 11L74 27Z' }),
        h('path', { class: 'rl-owl-body', d: 'M60 18C88 18 100 44 100 70C100 96 84 110 60 110C36 110 20 96 20 70C20 44 32 18 60 18Z' }),
        h('ellipse', { class: 'rl-owl-belly', cx: 60, cy: 86, rx: 24, ry: 21 }),
        h('path', { class: 'rl-owl-marks', d: 'M51 80l3 3 3-3M63 80l3 3 3-3M57 90l3 3 3-3' }),
        h('g', { class: 'rl-owl-wing rl-owl-wing-l' }, h('path', { d: 'M26 58C13 70 13 92 28 103C33 90 35 74 26 58Z' })),
        h('g', { class: 'rl-owl-wing rl-owl-wing-r' }, h('path', { d: 'M94 58C107 70 107 92 92 103C87 90 85 74 94 58Z' })),
        h('circle', { class: 'rl-owl-face', cx: 44, cy: 52, r: 19 }),
        h('circle', { class: 'rl-owl-face', cx: 76, cy: 52, r: 19 }),
        EYES.map(function (cx, i) {
          return h('g', { key: i },
            h('circle', { class: 'rl-owl-eye', cx: cx, cy: 52, r: 13 }),
            h('g', { class: 'rl-owl-pupil', style: { transform: 'translate(' + px + 'px,' + py + 'px)' } },
              h('circle', { cx: cx, cy: 52, r: 6.5 }),
              h('circle', { class: 'rl-owl-glint', cx: cx - 2.2, cy: 49.8, r: 2 })),
            h('g', { 'clip-path': 'url(#rl-owl-eye-' + i + ')' },
              h('rect', { class: 'rl-owl-lid', x: cx - 14, y: 38, width: 28, height: 28 })));
        }),
        h('path', { class: 'rl-owl-beak', d: 'M60 58L54.5 64L60 72L65.5 64Z' }),
        // крылья-«ладони» над глазами (пароль)
        EYES.map(function (cx, i) {
          return h('g', { key: 'c' + i, class: 'rl-owl-cover rl-owl-cover-' + (i ? 'r' : 'l'), style: { '--x': cx + 'px' } },
            h('path', { d: COVER, transform: 'translate(' + cx + ' 53)' + (i ? ' scale(-1 1)' : '') }));
        }))));
}

export { Owl };
