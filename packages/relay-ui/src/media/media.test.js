import { expect, test } from 'bun:test';
import { crc32, OggOpusWriter } from './oggopus.js';
import { pack, unpack, WaveformAnalyser, waveBars, WAVEFORM_BYTES } from './waveform.js';

test('5-bit waveform packing round-trips into 63 bytes', () => {
  const values = Array.from({ length: 100 }, (_, i) => (i * 7) % 32);
  const bytes = pack(values);
  expect(bytes.length).toBe(WAVEFORM_BYTES);
  expect(unpack(bytes).slice(0, 100)).toEqual(values);
});

test('analyser: silence is flat, a loud middle stands out, long input keeps bounded memory', () => {
  const a = new WaveformAnalyser();
  for (let i = 0; i < 300; i++) a.add(new Float32Array(2048).fill(i > 120 && i < 180 ? 0.8 : 0.01));
  expect(a.peaks.length).toBeLessThan(200);
  const v = unpack(a.finish()).slice(0, 100);
  expect(Math.max(...v)).toBe(31);
  expect(v[0]).toBeLessThan(5);
  expect(v[50]).toBe(31);
  const quiet = new WaveformAnalyser();
  quiet.add(new Float32Array(48000));
  expect(unpack(quiet.finish()).every((x) => x === 0)).toBe(true);
});

test('waveBars: fits any count, empty wave stays flat', () => {
  expect(waveBars([0, 31, 0], 6).length).toBe(6);
  expect(waveBars([], 4)).toEqual([0, 0, 0, 0]);
});

test('ogg: pages are well formed — magic, BOS/EOS flags, sequence, CRC, granule includes pre-skip', () => {
  const w = new OggOpusWriter({ serial: 1234 });
  for (let i = 0; i < 120; i++) w.add(new Uint8Array(80).fill(i), 960);   // 2.4 с по 20 мс
  const snap = w.snapshot();
  const bytes = w.finish();
  const pages = [];
  for (let o = 0; o < bytes.length;) {
    expect(String.fromCharCode(...bytes.subarray(o, o + 4))).toBe('OggS');
    const v = new DataView(bytes.buffer, o);
    const n = bytes[o + 26]; let body = 0;
    for (let k = 0; k < n; k++) body += bytes[o + 27 + k];
    const page = bytes.slice(o, o + 27 + n + body);
    const crc = new DataView(page.buffer).getUint32(22, true);
    new DataView(page.buffer).setUint32(22, 0, true);
    expect(crc32(page)).toBe(crc);
    pages.push({ flags: bytes[o + 5], granule: v.getUint32(6, true), seq: v.getUint32(18, true), serial: v.getUint32(14, true) });
    o += 27 + n + body;
  }
  expect(pages[0].flags).toBe(2);
  expect(pages.at(-1).flags).toBe(4);
  expect(pages.map((p) => p.seq)).toEqual(pages.map((_, i) => i));
  expect(pages.every((p) => p.serial === 1234)).toBe(true);
  expect(pages.at(-1).granule).toBe(312 + 120 * 960);
  expect(String.fromCharCode(...bytes.subarray(28, 36))).toBe('OpusHead');
  // снимок — тоже целый файл: начинается с BOS, последняя страница — с концом потока
  let last = 0;
  for (let o = 0; o < snap.length;) { last = o; const n = snap[o + 26]; let body = 0; for (let k = 0; k < n; k++) body += snap[o + 27 + k]; o += 27 + n + body; }
  expect(snap[5]).toBe(2);
  expect(snap[last + 5]).toBe(4);
});
