// Анимированные стикеры (TGS = Lottie JSON в gzip), как шапки настроек в Telegram.
// Рисует ThorVG (WASM) в одном общем воркере: главный поток только отдаёт canvas (OffscreenCanvas)
// и команды play/pause — ни разбора JSON, ни растеризации на нём нет.
// Пока стикер грузится, место занято (размер известен), а canvas проявляется плавно — без скачка.
// Без поддержки воркеров/OffscreenCanvas или при reduced motion — показываем последний кадр.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx, reducedMotion } from './kit.js';

var base = '/stickers/', lib = null;
var cache = new Map();   // имя → Promise<string> (распакованный JSON)
var WORKER_ID = 'relay-stickers';   // один воркер на все стикеры

/** Где лежат .tgs и движок. Вызывать до первого стикера. */
export function configureStickers(opts) {
  if (opts.base) base = opts.base;
  if (opts.wasmUrl) lib = import('@lottiefiles/dotlottie-web').then(function (m) {
    // абсолютный адрес: воркер создан из blob:, относительный путь там не сработает
    m.DotLottieWorker.setWasmUrl(new URL(opts.wasmUrl, location.href).href);
    return m;
  });
}

function supported() {
  return !!lib && typeof Worker === 'function' && typeof OffscreenCanvas === 'function' &&
    typeof HTMLCanvasElement !== 'undefined' && 'transferControlToOffscreen' in HTMLCanvasElement.prototype;
}

/** .tgs → строка JSON. Распаковка — потоком DecompressionStream, вне главного кода разбора. */
function loadTgs(name) {
  var p = cache.get(name);
  if (p) return p;
  p = fetch(base + name + '.tgs').then(function (res) {
    if (!res.ok || !res.body) throw new Error('sticker ' + name + ': ' + res.status);
    return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  });
  p.catch(function () { cache.delete(name); });
  cache.set(name, p);
  return p;
}

/** Заранее скачать и распаковать (например, при открытии меню настроек). */
export function preloadSticker(name) { if (supported()) loadTgs(name).catch(function () {}); }

/**
 * Стикер. props: name, size (px), loop (по умолчанию нет — играет один раз, как в Telegram),
 * replay ('hover' | 'click' | 'both' | null — повтор по наведению/клику), label (для скринридера; без него — декор).
 */
export function Sticker(props) {
  var size = props.size || 120;
  var canvasRef = useRef(null), playerRef = useRef(null);
  var shown = useState(false), setShown = shown[1];
  var replay = props.replay === undefined ? 'both' : props.replay;

  useEffect(function () {
    var canvas = canvasRef.current, alive = true, player = null;
    if (!canvas || !supported()) return;
    var still = reducedMotion();
    Promise.all([lib, loadTgs(props.name)]).then(function (r) {
      if (!alive) return;
      var m = r[0];
      player = new m.DotLottieWorker({
        canvas: canvas, data: r[1], workerId: WORKER_ID,
        autoplay: !still, loop: !!props.loop,
        renderConfig: { freezeOnOffscreen: true, autoResize: false, devicePixelRatio: Math.min(2, window.devicePixelRatio || 1) },
      });
      playerRef.current = player;
      player.addEventListener('load', function () {
        if (!alive) return;
        if (still) player.setFrame(Math.max(0, player.totalFrames - 1));
        setShown(true);
      });
    }).catch(function () { /* нет файла или движка — место остаётся пустым, без мигания */ });
    // вкладка скрыта — воркер не рисует
    function vis() { var p = playerRef.current; if (p && p.isLoaded) (document.hidden ? p.freeze() : p.unfreeze()); }
    document.addEventListener('visibilitychange', vis);
    return function () {
      alive = false;
      document.removeEventListener('visibilitychange', vis);
      if (player) player.destroy();
      playerRef.current = null;
    };
  }, [props.name, props.loop]);

  function again() {
    var p = playerRef.current;
    if (!p || !p.isLoaded || p.isPlaying || reducedMotion()) return;
    p.setFrame(0).then(function () { p.play(); });
  }

  return h('span', {
    class: cx('rl-sticker', shown[0] && 'rl-sticker-ready', props.class),
    style: { width: size + 'px', height: size + 'px' },
    role: props.label ? 'img' : undefined, 'aria-label': props.label, 'aria-hidden': props.label ? undefined : 'true',
    onPointerEnter: replay === 'hover' || replay === 'both' ? again : undefined,
    onClick: replay === 'click' || replay === 'both' ? again : undefined,
  },
    // размер буфера canvas задаём сами (autoResize выключен): size × dpr, без перерасчёта в воркере
    h('canvas', { ref: canvasRef, width: Math.round(size * Math.min(2, window.devicePixelRatio || 1)), height: Math.round(size * Math.min(2, window.devicePixelRatio || 1)) }));
}
