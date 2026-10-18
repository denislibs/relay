// Круг записи кружка — по центру экрана, как в Telegram Web A: въезжает снизу из маленького (350 мс),
// живое превью камеры отзеркалено, по краю — белое кольцо, заполняется по часовой от 12 часов за 60 с.
// Пока камера «просыпается» — размытая заглушка с переливом. На паузе с прослушиванием в круге — сама запись.
import { h } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx } from '../kit.js';

var R = 115.5, C = 2 * Math.PI * R;   // viewBox 240: радиус = 120 − 2.5 − 2

export function RoundRecorderView(props) {
  var s = props.session;
  var host = useRef(null), ring = useRef(null), raf = useRef(0);
  var st = useState(0), rerender = st[1];
  var ready = useState(false), leaving = useState(false);
  useEffect(function () {
    var live = true;
    s.ready.then(function () { if (live) ready[1](true); }, function () {});
    var off = s.onChange(function () { rerender(function (n) { return n + 1; }); });
    function tick() {
      raf.current = requestAnimationFrame(tick);
      var p = Math.min(1, s.elapsed() / s.maxMs);
      var off2 = (C * (1 - p)).toFixed(1);
      if (ring.current && ring.current.getAttribute('stroke-dashoffset') !== off2) ring.current.setAttribute('stroke-dashoffset', off2);
    }
    raf.current = requestAnimationFrame(tick);
    return function () { live = false; off(); cancelAnimationFrame(raf.current); };
  }, []);
  // живое превью / запись на паузе — настоящие <video> из сессии, вставляем в круг как есть
  useEffect(function () {
    var box = host.current;
    if (!box) return;
    var el = s.playback || s.preview;
    if (el.parentNode !== box) { while (box.firstChild) box.removeChild(box.firstChild); box.appendChild(el); }
    el.className = cx('rl-roundrec-video', el === s.preview && 'rl-roundrec-mirror');
  });
  useEffect(function () { if (props.closing) leaving[1](true); }, [props.closing]);
  return createPortal(h('div', { class: cx('rl-roundrec', ready[0] && 'rl-roundrec-ready', leaving[0] && 'rl-roundrec-out'), 'aria-hidden': 'true' },
    h('div', { class: 'rl-roundrec-media', ref: host }),
    h('div', { class: 'rl-roundrec-wait' }),
    h('svg', { class: 'rl-roundrec-ring', viewBox: '0 0 240 240' },
      h('circle', { ref: ring, cx: 120, cy: 120, r: R, 'stroke-dasharray': C.toFixed(1), 'stroke-dashoffset': C.toFixed(1) }))), document.body);
}
