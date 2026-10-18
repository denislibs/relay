// Запись голосового: микрофон → AudioWorklet (блоки по 2048 сэмплов) → WebCodecs AudioEncoder (Opus) → Ogg.
// Параметры как у Telegram Web: 48 кГц, моно, 32 кбит/с, кадр 20 мс; ограничений микрофона не задаём —
// шумоподавление, эхо и усиление браузер включает сам. Волна (63 байта) считается из тех же блоков.
import { OggOpusWriter } from './oggopus.js';
import { WaveformAnalyser } from './waveform.js';

var RATE = 48000;
var BLOCK = 2048;
export var VOICE_ENCODER = { codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: 32000 };
var MIN_MS = 1000;   // короче секунды не бывает: остановку дожидаемся

// Ворклет копит моно-блоки по 2048 и отдаёт их в основной поток; на паузе молчит, «reset» — выбросить недобранный блок
var WORKLET = [
  'class R extends AudioWorkletProcessor {',
  '  constructor() { super(); this.buf = new Float32Array(' + BLOCK + '); this.n = 0; this.on = true;',
  '    this.port.onmessage = (e) => { if (e.data === "pause") this.on = false; else if (e.data === "resume") { this.on = true; this.n = 0; } }; }',
  '  process(inputs) {',
  '    const ch = inputs[0] && inputs[0][0];',
  '    if (!ch || !this.on) return true;',
  '    for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === ' + BLOCK + ') { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }',
  '    return true;',
  '  }',
  '}',
  'registerProcessor("relay-voice-capture", R);',
].join('\n');

var supportCache = null;
/** Можно ли записывать: WebCodecs Opus, AudioWorklet, микрофон. Проверка один раз. */
export function voiceSupported() {
  if (supportCache) return supportCache;
  var ok = typeof AudioEncoder === 'function' && typeof AudioData === 'function' && typeof AudioWorkletNode === 'function'
    && typeof AudioContext === 'function' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  supportCache = ok ? AudioEncoder.isConfigSupported(VOICE_ENCODER).then(function (r) { return !!r.supported; }, function () { return false; }) : Promise.resolve(false);
  return supportCache;
}

/** Часы без пауз. */
function Timekeeper() { this.acc = 0; this.since = performance.now(); }
Timekeeper.prototype.ms = function () { return this.acc + (this.since == null ? 0 : performance.now() - this.since); };
Timekeeper.prototype.pause = function () { if (this.since != null) { this.acc += performance.now() - this.since; this.since = null; } };
Timekeeper.prototype.resume = function () { if (this.since == null) this.since = performance.now(); };

/**
 * Начать запись. onPeak(0…1) — пик каждого блока (живая волна). Возвращает управление записью.
 * Бросает ошибку браузера (NotAllowedError и т. п.) — вызывающий покажет подсказку.
 */
export async function startVoice(opts) {
  opts = opts || {};
  var stream = await navigator.mediaDevices.getUserMedia({ audio: opts.deviceId ? { deviceId: { exact: opts.deviceId } } : true });
  if (opts.signal && opts.signal.aborted) { stream.getTracks().forEach(function (t) { t.stop(); }); throw new DOMException('aborted', 'AbortError'); }
  var ctx = new AudioContext({ sampleRate: RATE });
  // запись продолжается и в фоне: браузер может «усыпить» контекст — будим
  ctx.onstatechange = function () { if (ctx.state === 'suspended' && state !== 'stopped') ctx.resume().catch(function () {}); };
  var url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  var src = ctx.createMediaStreamSource(stream);
  var node = new AudioWorkletNode(ctx, 'relay-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  var mute = ctx.createGain();
  mute.gain.value = 0;   // граф должен тянуть данные, но в колонки ничего не идёт
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);

  var ogg = new OggOpusWriter({ channels: 1 });
  var wave = new WaveformAnalyser();
  var time = new Timekeeper();
  var state = 'recording';
  var ts = 0;   // мкс, монотонно
  var encoder = new AudioEncoder({
    output: function (chunk, meta) {
      if (!ogg.head) ogg.setHead(meta && meta.decoderConfig && meta.decoderConfig.description);
      var bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      ogg.add(bytes, chunk.duration ? Math.round(chunk.duration * RATE / 1e6) : 960);
    },
    error: function (e) { console.warn('voice encoder', e); },
  });
  encoder.configure(VOICE_ENCODER);

  node.port.onmessage = function (e) {
    if (state !== 'recording') return;
    var block = e.data;
    var data = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: block.length, numberOfChannels: 1, timestamp: ts, data: block });
    ts += Math.round(block.length * 1e6 / RATE);
    encoder.encode(data);
    data.close();
    var peak = wave.add(block);
    if (opts.onPeak) opts.onPeak(peak);
  };

  function release() {
    try { src.disconnect(); node.disconnect(); mute.disconnect(); } catch (e) { /* уже */ }
    stream.getTracks().forEach(function (t) { t.stop(); });
    ctx.close().catch(function () {});
  }

  return {
    get state() { return state; },
    elapsed: function () { return time.ms(); },
    /** Пики всей записи для паузы (n значений 0…1). */
    overview: function (n) { return wave.overview(n); },
    pause: async function () {
      if (state !== 'recording') return;
      state = 'paused'; time.pause();
      node.port.postMessage('pause');
      await encoder.flush().catch(function () {});
    },
    resume: function () {
      if (state !== 'paused') return;
      state = 'recording'; time.resume();
      node.port.postMessage('resume');
    },
    /** Записанное на сейчас (Ogg) — для прослушивания на паузе. */
    snapshot: async function () {
      await encoder.flush().catch(function () {});
      return new Blob([ogg.snapshot()], { type: 'audio/ogg' });
    },
    /** Закончить: { blob, duration (целые секунды, ≥1), waveform (63 байта) }. cancel — без ожидания минимума и без результата. */
    stop: async function (cancel) {
      if (state === 'stopped') return null;
      var ms = time.ms();
      if (!cancel && ms < MIN_MS && state === 'recording') await new Promise(function (r) { setTimeout(r, MIN_MS - ms); });
      state = 'stopped'; time.pause();
      release();
      if (cancel) { try { encoder.close(); } catch (e) { /* уже */ } return null; }
      await encoder.flush().catch(function () {});
      try { encoder.close(); } catch (e) { /* уже */ }
      return { blob: new Blob([ogg.finish()], { type: 'audio/ogg' }), duration: Math.max(1, Math.round(time.ms() / 1000)), waveform: wave.finish() };
    },
  };
}
