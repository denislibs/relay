// Общий плеер голосовых (и звука кружков): играет одно за раз, помнит скорость, переходит к следующему,
// отдаёт кнопки системе (Media Session). Прогресс — один сигнал на кадр: подписчики рисуют сами,
// без перерисовки компонентов (как общий прогресс в Telegram Web A).
//
// Скорости как в Telegram: подписи 0.5 / 0.75 / 1 / 1.5 / 2, на деле — 0.66 / 0.8 / 1 / 1.4 / 1.8.

export var SPEEDS = [
  { label: '0.5X', rate: 0.66 }, { label: '0.75X', rate: 0.8 }, { label: '1X', rate: 1 }, { label: '1.5X', rate: 1.4 }, { label: '2X', rate: 1.8 },
];
var RATE_KEY = 'relay.voiceRate', FAST_KEY = 'relay.voiceFast';
function load(k, d) { try { var v = parseFloat(localStorage.getItem(k)); return v > 0 ? v : d; } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* без хранилища — до перезагрузки */ } }

var audio = null;          // один элемент на всё
var cur = null;            // { key, src, duration, title, subtitle, kind, onListened, listened }
var stopOther = null;      // кто играет вне плеера (кружок со звуком) — остановить, когда начнём своё
var subs = [];
var tickSubs = [];
var queue = null;          // (key, dir: 1|-1) → трек или null
var raf = 0;
var state = { key: null, playing: false, time: 0, duration: 0, rate: load(RATE_KEY, 1), fast: load(FAST_KEY, 1.8) };

function emit() { var s = snapshot(); for (var i = 0; i < subs.length; i++) subs[i](s); }
function snapshot() { return { key: state.key, playing: state.playing, time: state.time, duration: state.duration, rate: state.rate, fast: state.fast, track: cur }; }

function el() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('play', function () { state.playing = true; loop(); emit(); session(); });
  audio.addEventListener('pause', function () { state.playing = false; tick(); emit(); session(); });
  audio.addEventListener('loadedmetadata', function () { if (isFinite(audio.duration)) state.duration = audio.duration; emit(); session(); });
  audio.addEventListener('ended', function () {
    state.playing = false; state.time = 0; tick(); emit();
    // следующее голосовое того же чата — само (как в Telegram)
    var next = queue && cur ? queue(cur.key, 1) : null;
    if (next) play(next); else close();
  });
  audio.addEventListener('ratechange', session);
  audio.addEventListener('seeked', session);
  return audio;
}

function loop() {
  cancelAnimationFrame(raf);
  var last = -1;
  (function f() {
    if (!state.playing) return;
    var t = audio.currentTime;
    // меньше 1/4096 длительности — не сигналим (меньше пикселя на любой волне)
    if (Math.abs(t - last) * 4096 >= (state.duration || 1)) { last = t; state.time = t; tick(); }
    raf = requestAnimationFrame(f);
  })();
}
function tick() { for (var i = 0; i < tickSubs.length; i++) tickSubs[i](state.key, state.time, state.duration); }

/** Играть трек: { key, src, duration, title, subtitle, onListened? }. Тот же трек — продолжить. */
export function play(track) {
  var a = el();
  if (stopOther) { var f = stopOther; stopOther = null; f(); }
  if (!cur || cur.key !== track.key) {
    cur = track;
    state.key = track.key; state.time = 0; state.duration = track.duration || 0;
    a.src = track.src;
    a.currentTime = 0;
  }
  a.playbackRate = state.rate;
  var p = a.play();
  if (p && p.catch) p.catch(function () { state.playing = false; emit(); });
  if (track.onListened && !track.listenedSent) { track.listenedSent = true; track.onListened(); }
  emit();
}
export function pause() { if (audio) audio.pause(); }
export function toggle(track) {
  if (cur && cur.key === track.key && state.playing) pause(); else play(track);
}
/** Перемотка: доля 0…1 (не к самому концу — иначе сразу «закончилось» и переход к следующему). */
export function seek(key, fraction) {
  if (!cur || cur.key !== key || !audio) return;
  var d = state.duration || audio.duration || 0;
  var t = Math.min(Math.max(0.001, fraction * d), Math.max(0.001, d - 0.1));
  if (typeof audio.fastSeek === 'function') audio.fastSeek(t); else audio.currentTime = t;
  state.time = t; tick(); emit();
}
export function close() {
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  cur = null; state.key = null; state.playing = false; state.time = 0; state.duration = 0;
  tick(); emit(); session();
}
export function setRate(rate) {
  state.rate = rate; save(RATE_KEY, rate);
  if (rate !== 1) { state.fast = rate; save(FAST_KEY, rate); }
  if (audio) audio.playbackRate = rate;
  emit();
}
/** Кнопка скорости: 1× ↔ последняя быстрая (по умолчанию «2X» = 1.8). */
export function toggleFast() { setRate(state.rate === 1 ? state.fast : 1); }
export function step(dir) { var t = queue && cur ? queue(cur.key, dir) : null; if (t) play(t); }
export function hasStep(dir) { return !!(queue && cur && queue(cur.key, dir)); }

/** Источник соседних треков (лента чата). */
export function setQueue(fn) { queue = fn; }
/** Кто-то играет звук сам (кружок): наш трек — на паузу, а при нашем play — остановить его. */
export function claim(stop) { pause(); stopOther = stop; }
export function release(stop) { if (stopOther === stop) stopOther = null; }

export function playerState() { return snapshot(); }
export function subscribe(fn) { subs.push(fn); return function () { subs = subs.filter(function (x) { return x !== fn; }); }; }
/** Прогресс на каждый кадр воспроизведения: fn(key, time, duration). */
export function onTick(fn) { tickSubs.push(fn); return function () { tickSubs = tickSubs.filter(function (x) { return x !== fn; }); }; }

/* ---------- кнопки системы и наушников ---------- */
var sessionBound = false;
function session() {
  var ms = typeof navigator !== 'undefined' && navigator.mediaSession;
  if (!ms) return;
  if (!sessionBound) {
    sessionBound = true;
    var set = function (k, fn) { try { ms.setActionHandler(k, fn); } catch (e) { /* не поддерживается */ } };
    set('play', function () { if (cur) play(cur); });
    set('pause', pause);
    set('stop', close);
    set('seekbackward', function (d) { if (audio) audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10)); });
    set('seekforward', function (d) { if (audio) audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + ((d && d.seekOffset) || 10)); });
    set('seekto', function (d) { if (audio && d && d.seekTime != null) audio.currentTime = d.seekTime; });
    set('previoustrack', function () { step(-1); });
    set('nexttrack', function () { step(1); });
  }
  if (!cur) { ms.metadata = null; ms.playbackState = 'none'; return; }
  if (typeof MediaMetadata === 'function') ms.metadata = new MediaMetadata({ title: cur.title || 'Голосовое сообщение', artist: cur.subtitle || '', album: 'Relay' });
  ms.playbackState = state.playing ? 'playing' : 'paused';
  if (ms.setPositionState && audio && isFinite(audio.duration) && audio.duration > 0) {
    try { ms.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch (e) { /* неверная позиция */ }
  }
}
