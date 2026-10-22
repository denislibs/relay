// Общий плеер голосовых (и звука кружков): играет одно за раз, помнит скорость, переходит к следующему,
// отдаёт кнопки системе (Media Session). Прогресс — один сигнал на кадр: подписчики рисуют сами,
// без перерисовки компонентов (как общий прогресс в Telegram Web A).
//
// Скорости как в Telegram: подписи 0.5 / 0.75 / 1 / 1.5 / 2, на деле — 0.66 / 0.8 / 1 / 1.4 / 1.8.

export var SPEEDS = [
  { label: '0.5X', rate: 0.66 }, { label: '0.75X', rate: 0.8 }, { label: '1X', rate: 1 }, { label: '1.5X', rate: 1.4 }, { label: '2X', rate: 1.8 },
];
var RATE_KEY = 'relay.voiceRate', FAST_KEY = 'relay.voiceFast', VOL_KEY = 'relay.volume', ORDER_KEY = 'relay.musicOrder';
var ORDERS = ['all', 'one', 'shuffle', 'off'];   // музыка: по кругу, один трек, случайно, по порядку без повтора
function load(k, d) { try { var v = parseFloat(localStorage.getItem(k)); return v > 0 ? v : d; } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* без хранилища — до перезагрузки */ } }

var audio = null;          // один элемент на всё
var cur = null;            // { key, src, duration, title, subtitle, kind, onListened, listened }
var stopOther = null;      // кто играет вне плеера (кружок со звуком) — остановить, когда начнём своё
var subs = [];
var tickSubs = [];
var queue = null;          // (key, dir: 1|-1) → трек или null — голосовые ленты
var playlist = null;       // музыка: [трек…] в порядке воспроизведения (как в Telegram — новые сверху, «дальше» — старее)
var raf = 0;
var savedOrder = (function () { try { return localStorage.getItem(ORDER_KEY); } catch (e) { return null; } })();
var state = { key: null, playing: false, time: 0, duration: 0, rate: load(RATE_KEY, 1), fast: load(FAST_KEY, 1.8),
  volume: Math.min(1, load(VOL_KEY, 1)), muted: false, order: ORDERS.indexOf(savedOrder) >= 0 ? savedOrder : 'all' };

function emit() { var s = snapshot(); for (var i = 0; i < subs.length; i++) subs[i](s); }
function snapshot() { return { key: state.key, playing: state.playing, loading: !!state.loading, buffered: state.buffered || 0, time: state.time, duration: state.duration, rate: state.rate, fast: state.fast, track: cur, volume: state.volume, muted: state.muted, order: state.order, playlist: playlist }; }

function el() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  // с CORS: звук можно разобрать анализатором (кольцо вокруг играющего трека); хранилище отвечает CORS для приложения
  audio.crossOrigin = 'anonymous';
  audio.addEventListener('play', function () { state.playing = true; loop(); emit(); session(); });
  audio.addEventListener('pause', function () { state.playing = false; state.loading = false; tick(); emit(); session(); });
  audio.addEventListener('loadedmetadata', function () { if (isFinite(audio.duration)) state.duration = audio.duration; emit(); session(); });
  audio.addEventListener('ended', function () {
    state.playing = false; state.time = 0; tick(); emit();
    if (isMusic() && state.order === 'one') { audio.currentTime = 0; play(cur); return; }
    // дальше — следующий трек плейлиста / следующее голосовое того же чата (как в Telegram)
    var next = neighbour(1, true);
    if (next) play(next); else if (isMusic()) { audio.currentTime = 0; emit(); } else close();
  });
  // загрузка (как в Telegram Web K — кольцо поверх кнопки): с начала нового файла и пока ждём данных, до первого
  // звука; buffered — доля загруженного (дуга кольца)
  var busy = function (on) { if (state.loading !== on) { state.loading = on; emit(); } };
  audio.addEventListener('loadstart', function () { state.buffered = 0; busy(true); });
  audio.addEventListener('waiting', function () { busy(true); });
  audio.addEventListener('playing', function () { busy(false); });
  audio.addEventListener('canplaythrough', function () { if (audio.paused) busy(false); });
  audio.addEventListener('error', function () { busy(false); });
  audio.addEventListener('progress', function () {
    var b = audio.buffered, d = audio.duration;
    if (!b.length || !isFinite(d) || d <= 0) return;
    var f = Math.min(1, b.end(b.length - 1) / d);
    if (Math.abs(f - (state.buffered || 0)) > 0.01) { state.buffered = f; if (state.loading) emit(); }
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
  a.playbackRate = isMusic() ? 1 : state.rate;   // скорость — для голосовых
  a.volume = state.volume; a.muted = state.muted;
  if (isMusic()) graph();   // анализатор — только для музыки и только по жесту пользователя (play — по клику)
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
  cur = null; state.key = null; state.playing = false; state.loading = false; state.time = 0; state.duration = 0;
  tick(); emit(); session();
}
export function setRate(rate) {
  state.rate = rate; save(RATE_KEY, rate);
  if (rate !== 1) { state.fast = rate; save(FAST_KEY, rate); }
  if (audio && !isMusic()) audio.playbackRate = rate;
  emit();
}
/** Кнопка скорости: 1× ↔ последняя быстрая (по умолчанию «2X» = 1.8). */
export function toggleFast() { setRate(state.rate === 1 ? state.fast : 1); }
/** «Назад» дальше 5 с от начала — к началу трека (как в Telegram), иначе — предыдущий. */
export function step(dir) {
  if (dir < 0 && audio && audio.currentTime > 5) { seek(cur.key, 0); return; }
  var t = neighbour(dir, false);
  if (t) play(t);
}
export function hasStep(dir) { return !!neighbour(dir, false) || (dir < 0 && !!cur && isMusic()); }

function isMusic() { return !!(cur && cur.kind === 'music'); }
function inPlaylist() { if (!playlist || !cur) return -1; for (var i = 0; i < playlist.length; i++) if (playlist[i].key === cur.key) return i; return -1; }
/** Соседний трек: в плейлисте — по режиму порядка (по кругу/случайно), иначе — из очереди ленты. */
function neighbour(dir, auto) {
  var i = inPlaylist();
  if (i >= 0) {
    var n = playlist.length;
    if (state.order === 'shuffle' && n > 1) { var j = i; while (j === i) j = Math.floor(Math.random() * n); return playlist[j]; }
    var k = i + dir;
    if (k >= 0 && k < n) return playlist[k];
    if (state.order === 'all' || (!auto && state.order === 'one')) return playlist[(k + n) % n];
    return null;
  }
  return queue && cur ? queue(cur.key, dir) : null;
}

/** Плейлист музыки (вкладка «Музыка», лента чата, музыка профиля). null — снять. */
export function setPlaylist(list) { playlist = list && list.length ? list : null; emit(); }
/** Порядок: 'all' по кругу, 'one' повтор трека, 'shuffle' случайно, 'off' по порядку. */
export function setOrder(order) { if (ORDERS.indexOf(order) < 0) return; state.order = order; try { localStorage.setItem(ORDER_KEY, order); } catch (e) { /* */ } emit(); }
export function setVolume(v) { state.volume = Math.max(0, Math.min(1, v)); state.muted = state.volume === 0; save(VOL_KEY, state.volume || 1); if (audio) { audio.volume = state.volume; audio.muted = state.muted; } emit(); }
export function toggleMute() { state.muted = !state.muted; if (audio) audio.muted = state.muted; emit(); }

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
  if (typeof MediaMetadata === 'function') ms.metadata = new MediaMetadata({ title: cur.title || 'Голосовое сообщение', artist: cur.performer || cur.subtitle || '', album: 'Relay' });
  ms.playbackState = state.playing ? 'playing' : 'paused';
  if (ms.setPositionState && audio && isFinite(audio.duration) && audio.duration > 0) {
    try { ms.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch (e) { /* неверная позиция */ }
  }
}

/* ---------- спектр для кольца вокруг играющего трека ----------
   AudioContext и AnalyserNode на том же <audio>: звук идёт дальше в выход как обычно. Создаётся при первом play
   музыки (жест пользователя — иначе браузер не даст). На iOS — нет (там MediaElementSource ломает фоновое
   воспроизведение): кольцо рисует синтетическую волну. */
var actx = null, analyserNode = null;
var IS_IOS = typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
function graph() {
  if (IS_IOS || analyserNode === false) return;
  try {
    var Ctor = typeof AudioContext !== 'undefined' ? AudioContext : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
    if (!Ctor) { analyserNode = false; return; }
    if (!actx) {
      actx = new Ctor();
      actx.onstatechange = function () { if (actx.state === 'suspended' && state.playing) actx.resume().catch(function () {}); };
    }
    if (actx.state === 'suspended') actx.resume().catch(function () {});
    if (!analyserNode) {
      var source = actx.createMediaElementSource(el());
      analyserNode = actx.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0.85;
      source.connect(analyserNode);
      analyserNode.connect(actx.destination);
    }
  } catch (e) { analyserNode = false; }   // не вышло — без анализатора, звук как был
}
/** Анализатор текущего звука или null (нет, ещё не создан, контекст не запущен). */
export function analyser() {
  return analyserNode && actx && actx.state === 'running' ? analyserNode : null;
}
