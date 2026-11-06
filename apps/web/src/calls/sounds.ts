/**
 * Звуки звонка: гудки звонящему, мелодия входящего, «соединились», «звонок окончен», «занято», «переподключение»,
 * «не удалось».
 *
 * Звуки — файлы apps/web/public/sounds/calls/<имя>.mp3 (какие положить — решает владелец проекта; список имён —
 * FILES ниже). Файла нет — играет свой синтезированный тон: ноты считаются в PCM один раз (WAV в Blob URL).
 *
 * Не WebAudio: первый new AudioContext() синхронно поднимает аудиосервис (250–600 мс главного потока, docs/SMOOTH-UI.md
 * §5) — и это пришлось бы на нажатие «Позвонить». <audio>.play() возвращается сразу, вывод — вне главного потока,
 * динамик выбирается setSinkId.
 */

type Note = { f: number[]; at: number; dur: number };
type Tone = { notes: Note[]; period: number };   // period — длина файла (с тишиной после нот), повтор — loop

const RATE = 22050;

/** Свои тоны — запасные, когда файла звука нет, и мелодии «Колокольчики» / «Пульс». */
const TONES: Record<string, Tone> = {
  outgoing: { notes: [{ f: [425], at: 0, dur: 1 }], period: 4 },
  busy: { notes: [{ f: [425], at: 0, dur: 0.35 }], period: 0.7 },
  connect: { notes: [{ f: [880], at: 0, dur: 0.12 }, { f: [1320], at: 0.14, dur: 0.16 }], period: 0.35 },
  end: { notes: [{ f: [480], at: 0, dur: 0.18 }, { f: [360], at: 0.22, dur: 0.3 }], period: 0.6 },
  connecting: { notes: [{ f: [600], at: 0, dur: 0.1 }], period: 1.2 },
  failed: { notes: [{ f: [520], at: 0, dur: 0.15 }, { f: [390], at: 0.2, dur: 0.15 }, { f: [290], at: 0.4, dur: 0.3 }], period: 0.8 },
  test: { notes: [{ f: [440], at: 0, dur: 0.25 }, { f: [554], at: 0.3, dur: 0.25 }, { f: [659], at: 0.6, dur: 0.4 }], period: 1.05 },
  'ring:classic': { notes: [{ f: [660, 880], at: 0, dur: 0.4 }, { f: [660, 880], at: 0.6, dur: 0.4 }], period: 2.5 },
  'ring:chime': { notes: [{ f: [784], at: 0, dur: 0.25 }, { f: [988], at: 0.25, dur: 0.25 }, { f: [1175], at: 0.5, dur: 0.45 }], period: 2.5 },
  'ring:pulse': { notes: [{ f: [523], at: 0, dur: 0.15 }, { f: [523], at: 0.25, dur: 0.15 }, { f: [523], at: 0.5, dur: 0.15 }, { f: [698], at: 0.75, dur: 0.35 }], period: 2.5 },
};

/** Звук → файл в /sounds/calls/ (мелодия «Стандартная» — incoming). */
export const FILES: Record<string, string> = {
  outgoing: 'outgoing', busy: 'busy', connect: 'connect', end: 'end', connecting: 'connecting', failed: 'failed', 'ring:classic': 'incoming',
};
const fileUrl = (name: string) => `/sounds/calls/${FILES[name]}.mp3`;

/** WAV (PCM 16 бит, моно) с огибающей без щелчков. */
export function renderWav(t: Tone): Uint8Array {
  const n = Math.round(t.period * RATE);
  const pcm = new Int16Array(n);
  const ramp = 0.02 * RATE;
  for (const note of t.notes) {
    const s0 = Math.round(note.at * RATE), len = Math.round(note.dur * RATE);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const env = Math.min(1, i / ramp, (len - i) / ramp);
      let v = 0;
      for (const f of note.f) v += Math.sin((2 * Math.PI * f * i) / RATE);
      pcm[s0 + i] = Math.max(-32767, Math.min(32767, pcm[s0 + i] + (v / note.f.length) * env * 0.5 * 32767));
    }
  }
  const out = new Uint8Array(44 + n * 2);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  new Uint8Array(out.buffer, 44).set(new Uint8Array(pcm.buffer));
  return out;
}

const synth = new Map<string, string>();
function synthUrl(name: string): string {
  let u = synth.get(name);
  if (!u) { u = URL.createObjectURL(new Blob([renderWav(TONES[name])], { type: 'audio/wav' })); synth.set(name, u); }
  return u;
}

/** Файла звука нет — запоминаем после первой ошибки и дальше сразу играем свой тон. */
const hasFile = new Map<string, boolean>();
const urlOf = (name: string) => (FILES[name] && hasFile.get(name) !== false ? fileUrl(name) : synthUrl(name));

let el: HTMLAudioElement | null = null;
let sink: string | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

function play(name: string, volume: number, loop: boolean, stopAfterMs = 0): void {
  if (typeof Audio === 'undefined' || !TONES[name]) return;
  stopNow();
  el ??= new Audio();
  const a = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  a.loop = loop;
  a.volume = Math.max(0, Math.min(1, volume));
  a.src = urlOf(name);
  // файла нет (404) — запоминаем и играем свой тон
  a.onerror = () => { if (FILES[name] && hasFile.get(name) !== false) { hasFile.set(name, false); if (el === a) { a.src = synthUrl(name); void a.play().catch(() => {}); } } };
  void (a.setSinkId ? a.setSinkId(sink ?? '').catch(() => {}) : Promise.resolve()).then(() => a.play().catch(() => {}));
  if (stopAfterMs) stopTimer = setTimeout(stopNow, stopAfterMs);
}

function stopNow(): void {
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (el) { el.onerror = null; el.pause(); el.currentTime = 0; }
}

/** Выход для звуков звонка (динамик из настроек; null — системный). */
export async function soundSink(deviceId: string | null): Promise<void> { sink = deviceId; }

/** В простое после загрузки: посчитать запасные тоны — первый звонок ничего не ждёт. Есть ли файлы, выясняется при первом
 *  проигрывании (лишних запросов на каждом открытии страницы нет). */
export function warmCallSounds(): void {
  for (const k of Object.keys(TONES)) synthUrl(k);
}

const ring = (name: string) => 'ring:' + (TONES['ring:' + name] ? name : 'classic');

export const sounds = {
  ringback(volume: number): void { play('outgoing', volume, true); },
  ringtone(name: string, volume: number): void { play(ring(name), volume, true); },
  preview(name: string, volume: number): void { play(ring(name), volume, false); },
  test(volume: number): void { play('test', volume, false); },
  connected(volume: number): void { play('connect', volume, false); },
  ended(volume: number): void { play('end', volume, false); },
  busy(volume: number): void { play('busy', volume, true, 3000); },
  reconnecting(volume: number): void { play('connecting', volume, true); },
  failed(volume: number): void { play('failed', volume, false); },
  stop(): void { stopNow(); },
};
