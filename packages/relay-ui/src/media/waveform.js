// Волна голосового сообщения — в том же виде, что у официальных клиентов Telegram:
// 100 значений по 5 бит (0…31), упакованы подряд младшими битами вперёд в 63 байта.
// Пики копятся с ограниченной памятью: когда корзин становится 200, соседние сливаются (берётся максимум)
// и размер корзины удваивается — так длина записи не важна.

export var WAVEFORM_VALUES = 100;
export var WAVEFORM_BYTES = 63;
var MERGE_AT = 200;

export function WaveformAnalyser() {
  this.peaks = [];
  this.bucket = 1;      // сэмплов в корзине
  this.fill = 0;        // сэмплов в текущей корзине
  this.cur = 0;         // максимум текущей корзины
}

/** Блок сэмплов (Float32, −1…1). Возвращает пик блока (0…1) — для живой волны при записи. */
WaveformAnalyser.prototype.add = function (block) {
  var blockPeak = 0;
  for (var i = 0; i < block.length; i++) {
    var a = block[i] < 0 ? -block[i] : block[i];
    if (a > blockPeak) blockPeak = a;
    var v = a * 32767;
    if (v > this.cur) this.cur = v;
    if (++this.fill >= this.bucket) {
      this.peaks.push(this.cur);
      this.cur = 0; this.fill = 0;
      if (this.peaks.length >= MERGE_AT) {
        var merged = [];
        for (var k = 0; k + 1 < this.peaks.length; k += 2) merged.push(Math.max(this.peaks[k], this.peaks[k + 1]));
        this.peaks = merged;
        this.bucket *= 2;
      }
    }
  }
  return Math.min(1, blockPeak);
};

/** Все пики записи на сейчас, сжатые до n значений (0…1 относительно максимума) — для паузы и прослушивания. */
WaveformAnalyser.prototype.overview = function (n) {
  var src = this.fill ? this.peaks.concat([this.cur]) : this.peaks;
  var out = resample(src, n), max = 0;
  for (var i = 0; i < out.length; i++) if (out[i] > max) max = out[i];
  return out.map(function (v) { return max ? v / max : 0; });
};

/** Итог: 63 байта. Нормировка — по среднему ×1.8 (но не ниже 2500), значения обрезаются до 31. */
WaveformAnalyser.prototype.finish = function () {
  var src = this.fill ? this.peaks.concat([this.cur]) : this.peaks;
  var values = src.length > WAVEFORM_VALUES ? resample(src, WAVEFORM_VALUES) : src.slice();
  while (values.length < WAVEFORM_VALUES) values.push(0);
  var sum = 0;
  for (var i = 0; i < values.length; i++) sum += values[i];
  var norm = Math.max(2500, (sum / values.length) * 1.8);
  return pack(values.map(function (v) { return Math.min(31, Math.floor(Math.min(v, norm) * 31 / norm)); }));
};

/** Сжатие по максимуму: каждое выходное значение — максимум своей доли входа. */
function resample(src, n) {
  if (!src.length) return [];
  var out = [];
  for (var i = 0; i < n; i++) {
    var a = Math.floor(i * src.length / n), b = Math.max(a + 1, Math.floor((i + 1) * src.length / n)), m = 0;
    for (var k = a; k < b && k < src.length; k++) if (src[k] > m) m = src[k];
    out.push(m);
  }
  return out;
}

/** 5-битные значения → байты, младшие биты первыми. */
export function pack(values) {
  var bytes = new Uint8Array(Math.ceil(values.length * 5 / 8));
  for (var i = 0; i < values.length; i++) {
    var bit = i * 5, v = values[i] & 31, byte = bit >> 3, shift = bit & 7;
    bytes[byte] |= (v << shift) & 0xff;
    if (shift > 3) bytes[byte + 1] |= v >> (8 - shift);
  }
  return bytes;
}

/** Байты → 5-битные значения (сколько поместилось целиком). */
export function unpack(bytes) {
  var n = Math.floor(bytes.length * 8 / 5), out = [];
  for (var i = 0; i < n; i++) {
    var bit = i * 5, byte = bit >> 3, shift = bit & 7;
    var word = bytes[byte] | ((bytes[byte + 1] || 0) << 8);
    out.push((word >> shift) & 31);
  }
  return out;
}

export function toBase64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
export function fromBase64(b64) {
  try { var s = atob(b64), out = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; } catch (e) { return new Uint8Array(0); }
}

/**
 * Значения волны (0…31) → столько полосок, сколько влезает в пузырь: каждая — среднее трёх соседей
 * вокруг своей точки (сглаживает, не теряя формы). Пустая волна — ровные нули той же длины.
 */
export function waveBars(values, count) {
  var out = [];
  if (!values || !values.length) { for (var z = 0; z < count; z++) out.push(0); return out; }
  for (var i = 0; i < count; i++) {
    var at = Math.floor(i * values.length / count), s = 0, n = 0;
    for (var k = at - 1; k <= at + 1; k++) if (k >= 0 && k < values.length) { s += values[k]; n++; }
    out.push(s / n);
  }
  return out;
}
