// Контейнер Ogg для потока Opus (RFC 3533 — Ogg, RFC 7845 — Opus в Ogg).
// Первая страница — OpusHead, вторая — OpusTags, дальше аудио; страница закрывается каждую секунду звука
// (48000 сэмплов) или когда кончаются 255 сегментов. snapshot() отдаёт уже записанное + временную последнюю
// страницу — так можно прослушать запись на паузе, не останавливая её.

var RATE = 48000;
var PRE_SKIP = 312;            // 6.5 мс задержки кодера при 48 кГц
var PAGE_SAMPLES = RATE;       // ~1 с звука на страницу
var MAX_SEGMENTS = 255;

var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var i = 0; i < 256; i++) {
    var r = i << 24;
    for (var k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  var c = 0;
  for (var i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return c >>> 0;
}

function concat(parts) {
  var n = 0, i;
  for (i = 0; i < parts.length; i++) n += parts[i].length;
  var out = new Uint8Array(n), o = 0;
  for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
  return out;
}
var enc = new TextEncoder();

/** Заголовок OpusHead (19 байт): версия 1, каналы, pre-skip, исходная частота, усиление 0, раскладка 0. */
export function opusHead(channels, preSkip, rate) {
  var b = new Uint8Array(19), v = new DataView(b.buffer);
  b.set(enc.encode('OpusHead'), 0);
  b[8] = 1; b[9] = channels;
  v.setUint16(10, preSkip, true); v.setUint32(12, rate, true); v.setInt16(16, 0, true); b[18] = 0;
  return b;
}
function opusTags(vendor) {
  var vb = enc.encode(vendor), b = new Uint8Array(8 + 4 + vb.length + 4), v = new DataView(b.buffer);
  b.set(enc.encode('OpusTags'), 0);
  v.setUint32(8, vb.length, true); b.set(vb, 12); v.setUint32(12 + vb.length, 0, true);
  return b;
}

export function OggOpusWriter(opts) {
  opts = opts || {};
  this.channels = opts.channels || 1;
  this.serial = (opts.serial != null ? opts.serial : Math.floor(Math.random() * 0xffffffff)) >>> 0;
  this.seq = 0;
  this.pages = [];             // готовые страницы
  this.pending = [];           // пакеты текущей страницы
  this.pendingSamples = 0;
  this.granule = 0;            // сэмплы, включая pre-skip
  this.head = null;
  this.vendor = opts.vendor || 'relay';
}

/** Заголовок от кодера (decoderConfig.description), если он его дал; иначе свой. */
OggOpusWriter.prototype.setHead = function (desc) {
  if (desc && desc.byteLength >= 19) {
    var b = desc instanceof Uint8Array ? desc : new Uint8Array(desc.buffer ? desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength) : desc);
    if (String.fromCharCode.apply(null, b.subarray(0, 8)) === 'OpusHead') { this.head = b; return; }
  }
  this.head = opusHead(this.channels, PRE_SKIP, RATE);
};

OggOpusWriter.prototype.page = function (packets, granule, flags) {
  var lacing = [];
  for (var i = 0; i < packets.length; i++) {
    var len = packets[i].length;
    while (len >= 255) { lacing.push(255); len -= 255; }
    lacing.push(len);
  }
  var header = new Uint8Array(27 + lacing.length), v = new DataView(header.buffer);
  header.set(enc.encode('OggS'), 0);
  header[4] = 0; header[5] = flags;
  // позиция — 64 бита little-endian
  v.setUint32(6, granule % 0x100000000, true); v.setUint32(10, Math.floor(granule / 0x100000000), true);
  v.setUint32(14, this.serial, true); v.setUint32(18, this.seq++, true); v.setUint32(22, 0, true);
  header[26] = lacing.length;
  header.set(lacing, 27);
  var page = concat([header].concat(packets));
  new DataView(page.buffer).setUint32(22, crc32(page), true);
  return page;
};

OggOpusWriter.prototype.start = function () {
  if (!this.head) this.setHead(null);
  this.pages.push(this.page([this.head], 0, 0x02));          // BOS
  this.pages.push(this.page([opusTags(this.vendor)], 0, 0));
  var preSkip = new DataView(this.head.buffer, this.head.byteOffset, this.head.byteLength).getUint16(10, true);
  this.granule = preSkip;
};

function segmentsOf(len) { return Math.floor(len / 255) + 1; }

/** Пакет Opus и его длительность в сэмплах 48 кГц. */
OggOpusWriter.prototype.add = function (packet, samples) {
  if (!this.pages.length) this.start();
  var segs = 0;
  for (var i = 0; i < this.pending.length; i++) segs += segmentsOf(this.pending[i].length);
  if (this.pending.length && segs + segmentsOf(packet.length) > MAX_SEGMENTS) this.flush(false);
  this.pending.push(packet);
  this.pendingSamples += samples;
  this.granule += samples;
  if (this.pendingSamples >= PAGE_SAMPLES) this.flush(false);
};

OggOpusWriter.prototype.flush = function (last) {
  if (!this.pending.length && !last) return;
  this.pages.push(this.page(this.pending, this.granule, last ? 0x04 : 0));
  this.pending = []; this.pendingSamples = 0;
};

/** Запись на сейчас как самостоятельный файл (с временной последней страницей) — запись при этом продолжается. */
OggOpusWriter.prototype.snapshot = function () {
  if (!this.pages.length) this.start();
  var tail = this.page(this.pending, this.granule, 0x04);   // конец потока — у временной страницы
  this.seq--;   // временная страница не занимает номер
  return concat(this.pages.concat([tail]));
};

OggOpusWriter.prototype.finish = function () {
  if (!this.pages.length) this.start();
  this.flush(true);
  return concat(this.pages);
};

export { crc32 };
