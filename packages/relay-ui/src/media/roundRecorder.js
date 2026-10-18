// Запись кружка (видеосообщения) — параметры как у Telegram Web A:
//  камера: фронтальная, 720×720 (ideal), 30 к/с; звук — микрофон без ограничений (настройки браузера);
//  кадр: холст 400×400 на каждый кадр — центр-квадрат с камеры, отзеркаленный, вписанный в круг r=201,
//        под ним — тот же кадр, размытый на 14 px с запасом 24 px по краям и притемнённый на 10%;
//  запись: canvas.captureStream(30) + микрофон → MediaRecorder MP4 (H.264 Baseline + AAC), 1.2 Мбит/с видео,
//          64 кбит/с звук, одним куском при остановке; параллельно — WebM (VP8/Opus, куски по 250 мс)
//          только для просмотра на паузе (MP4 в Chrome не отдаёт данные до конца записи);
//  предел 60 с (дальше — пауза, отправить или удалить), короче 1 с — не отправляется;
//  первые кадры камеры чёрные/пересвеченные — ждём «живой» кадр и устоявшуюся яркость.
// Safari и iOS — без кружков: WebKit портит кадры captureStream и может зависнуть на stop().
import { WaveformAnalyser } from './waveform.js';

export var ROUND_SIZE = 400;
export var ROUND_MAX_MS = 60000;
var ROUND_MIN_MS = 1000;
var FPS = 30;
var VIDEO_BPS = 1200000, AUDIO_BPS = 64000;
var MP4 = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'];
var WEBM = ['video/webm;codecs=vp8,opus', 'video/webm'];

function pick(list) {
  for (var i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported(list[i])) return list[i];
  return null;
}
function isWebKit() {
  var ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) || (/Safari\//.test(ua) && !/(Chrome|Chromium|Edg|OPR|Firefox)\//.test(ua));
}

/** Можно ли записывать кружки в этом браузере. */
export function roundSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && typeof MediaRecorder === 'function'
    && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && !isWebKit() && !!pick(MP4);
}

/** Ждём «живой» кадр: средняя яркость выше 10 или кадры меняются; потом — пока яркость не перестанет прыгать. */
async function waitForVisibleFrame(video) {
  var c = document.createElement('canvas');
  c.width = c.height = 16;
  var g = c.getContext('2d', { willReadFrequently: true });
  function mean() {
    g.drawImage(video, 0, 0, 16, 16);
    var d = g.getImageData(0, 0, 16, 16).data, s = 0;
    for (var i = 0; i < d.length; i += 4) s += (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    return s / 256;
  }
  var frame = function () { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); };
  var t0 = performance.now(), prev = -1;
  while (performance.now() - t0 < 1500) {
    await frame();
    if (!video.videoWidth) continue;
    var m = mean();
    if (m > 10 || (prev >= 0 && Math.abs(m - prev) > 1)) break;
    prev = m;
  }
  var t1 = performance.now(), calm = 0; prev = -1;
  while (performance.now() - t1 < 1500 && calm < 4) {
    await frame();
    var v = mean();
    calm = prev >= 0 && Math.abs(v - prev) < 1 ? calm + 1 : 0;
    prev = v;
  }
}

function Timekeeper() { this.acc = 0; this.since = performance.now(); }
Timekeeper.prototype.ms = function () { return this.acc + (this.since == null ? 0 : performance.now() - this.since); };
Timekeeper.prototype.pause = function () { if (this.since != null) { this.acc += performance.now() - this.since; this.since = null; } };
Timekeeper.prototype.resume = function () { if (this.since == null) this.since = performance.now(); };

/** Маленькое превью для ленты (до загрузки видео): JPEG 40×40 data-URL. */
function tinyThumb(source) {
  try {
    var c = document.createElement('canvas');
    c.width = c.height = 40;
    c.getContext('2d').drawImage(source, 0, 0, 40, 40);
    var url = c.toDataURL('image/jpeg', 0.7);
    return url.length <= 4096 ? url : null;
  } catch (e) { return null; }
}

/**
 * Начать запись. opts.onPeak(0…1) — живая волна звука. Возвращает «сессию» для панели записи и круга:
 * { kind:'round', preview (video живой камеры), ready (Promise — кадр устоялся), elapsed, pause, resume, overview,
 *   media() — запись на сейчас для просмотра, stop(cancel) → { blob, duration, size, thumb } | null, onLimit(fn), onChange(fn) }
 */
export async function startRound(opts) {
  opts = opts || {};
  var stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 }, frameRate: { ideal: FPS } },
    audio: true,
  });
  var mainType = pick(MP4), snapType = pick(WEBM);
  if (!mainType) { stream.getTracks().forEach(function (t) { t.stop(); }); throw new DOMException('mp4 recording is not supported', 'NotSupportedError'); }

  var preview = document.createElement('video');
  preview.muted = true; preview.playsInline = true; preview.autoplay = true;
  preview.srcObject = stream;
  await preview.play().catch(function () {});

  var canvas = document.createElement('canvas');
  canvas.width = canvas.height = ROUND_SIZE;
  var g = canvas.getContext('2d');
  var drawing = false, raf = 0;
  function draw() {
    var vw = preview.videoWidth, vh = preview.videoHeight;
    if (vw && vh) {
      var side = Math.min(vw, vh), sx = (vw - side) / 2, sy = (vh - side) / 2, S = ROUND_SIZE;
      g.save();
      g.translate(S, 0); g.scale(-1, 1);                       // как в зеркале — и в записи тоже
      g.filter = 'blur(14px)';
      g.drawImage(preview, sx, sy, side, side, -24, -24, S + 48, S + 48);
      g.filter = 'none';
      g.fillStyle = 'rgba(0,0,0,0.1)';
      g.fillRect(0, 0, S, S);
      g.beginPath(); g.arc(S / 2, S / 2, S / 2 + 1, 0, Math.PI * 2); g.clip();
      g.drawImage(preview, sx, sy, side, side, 0, 0, S, S);
      g.restore();
    }
  }
  function loop() { draw(); if (drawing) raf = requestAnimationFrame(loop); }
  function startDrawing() { if (!drawing) { drawing = true; loop(); } }
  function stopDrawing() { drawing = false; cancelAnimationFrame(raf); }

  var listeners = { limit: [], change: [] };
  function fire(kind) { listeners[kind].forEach(function (f) { f(); }); }
  var state = 'warming';
  var time = null, main = null, snap = null, mainChunks = [], snapChunks = [];
  var wave = new WaveformAnalyser();
  var audioCtx = null, tap = null, limitTimer = 0, playback = null;

  var ready = (async function () {
    await waitForVisibleFrame(preview);
    if (state === 'stopped') return;
    startDrawing();
    var mixed = new MediaStream([canvas.captureStream(FPS).getVideoTracks()[0]].concat(stream.getAudioTracks()));
    main = new MediaRecorder(mixed, { mimeType: mainType, videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: AUDIO_BPS });
    main.ondataavailable = function (e) { if (e.data && e.data.size) mainChunks.push(e.data); };
    if (snapType) {
      snap = new MediaRecorder(mixed, { mimeType: snapType, videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: AUDIO_BPS });
      snap.ondataavailable = function (e) { if (e.data && e.data.size) snapChunks.push(e.data); };
    }
    // живая волна — с копии дорожки микрофона (общую дорожку с записью делить нельзя: одна сторона читает тишину)
    try {
      audioCtx = new AudioContext();
      var src = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks().map(function (t) { return t.clone(); })));
      tap = audioCtx.createScriptProcessor(2048, 1, 1);
      tap.onaudioprocess = function (e) {
        if (state !== 'recording') return;
        var p = wave.add(e.inputBuffer.getChannelData(0));
        if (opts.onPeak) opts.onPeak(p);
      };
      var mute = audioCtx.createGain(); mute.gain.value = 0;
      src.connect(tap); tap.connect(mute); mute.connect(audioCtx.destination);
      audioCtx.resume().catch(function () {});
    } catch (e) { /* без волны */ }
    main.start();
    if (snap) snap.start(250);
    time = new Timekeeper();
    state = 'recording';
    limitTimer = setInterval(function () {
      if (state === 'recording' && time.ms() >= ROUND_MAX_MS) { session.pause().then(function () { fire('limit'); }); }
    }, 250);
    fire('change');
  })();

  function stopTracks() {
    stopDrawing();
    clearInterval(limitTimer);
    // камера гаснет чуть позже: круг успевает уйти на последнем кадре, без чёрной вспышки
    setTimeout(function () { stream.getTracks().forEach(function (t) { t.stop(); }); }, 300);
    if (audioCtx) audioCtx.close().catch(function () {});
  }
  function stopRecorder(r) {
    return new Promise(function (res) {
      if (!r || r.state === 'inactive') return res();
      r.onstop = function () { res(); };
      try { r.stop(); } catch (e) { res(); }
    });
  }

  var session = {
    kind: 'round',
    preview: preview,
    ready: ready,
    get state() { return state; },
    get playback() { return playback; },
    maxMs: ROUND_MAX_MS,
    elapsed: function () { return time ? Math.min(ROUND_MAX_MS, time.ms()) : 0; },
    overview: function (n) { return wave.overview(n); },
    onLimit: function (f) { listeners.limit.push(f); },
    onChange: function (f) { listeners.change.push(f); return function () { listeners.change = listeners.change.filter(function (x) { return x !== f; }); }; },
    pause: async function () {
      await ready;
      if (state !== 'recording') return;
      state = 'paused'; time.pause(); stopDrawing();
      try { main.pause(); } catch (e) { /* уже */ }
      if (snap && snap.state === 'recording') {
        snap.pause();
        await new Promise(function (r) { var t = setTimeout(r, 1000); snap.addEventListener('dataavailable', function () { clearTimeout(t); r(); }, { once: true }); snap.requestData(); });
      }
      preview.pause();
      fire('change');
    },
    resume: function () {
      if (state !== 'paused' || time.ms() >= ROUND_MAX_MS) return;
      if (playback) { playback.pause(); playback = null; }
      preview.play().catch(function () {});
      draw();   // первый кадр после паузы — свежий, а не застывший
      state = 'recording'; time.resume();
      try { main.resume(); } catch (e) { /* уже */ }
      if (snap && snap.state === 'paused') snap.resume();
      startDrawing();
      fire('change');
    },
    /** Записанное на сейчас — <video> из WebM (у WebM нет длительности: перематываем в конец, чтобы браузер её узнал). */
    media: async function () {
      if (!snapChunks.length) return null;
      var v = document.createElement('video');
      v.playsInline = true;
      v.src = URL.createObjectURL(new Blob(snapChunks, { type: snapType }));
      await new Promise(function (r) { v.onloadedmetadata = r; setTimeout(r, 2000); });
      if (!isFinite(v.duration)) {
        await new Promise(function (r) { v.ondurationchange = function () { if (isFinite(v.duration)) r(); }; v.currentTime = Number.MAX_SAFE_INTEGER; setTimeout(r, 2000); });
        v.currentTime = 0;
      }
      playback = v;
      fire('change');
      return v;
    },
    stop: async function (cancel) {
      if (state === 'stopped') return null;
      state = 'stopped';
      await ready.catch(function () {});
      var ms = time ? Math.min(ROUND_MAX_MS, time.ms()) : 0;
      var thumb = tinyThumb(preview.videoWidth ? canvas : preview);
      await Promise.all([stopRecorder(main), stopRecorder(snap)]);
      stopTracks();
      if (playback) { playback.pause(); playback = null; }
      fire('change');
      if (cancel || ms < ROUND_MIN_MS || !mainChunks.length) return null;
      return { blob: new Blob(mainChunks, { type: mainType.split(';')[0] }), duration: Math.max(1, Math.round(ms / 1000)), size: ROUND_SIZE, thumb: thumb };
    },
  };
  return session;
}
