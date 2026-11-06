/**
 * Звуки звонка — свои, синтезированные (без файлов и без чужих мелодий): гудки звонящему, мелодия входящего,
 * короткие сигналы «соединились» / «звонок окончен» / «занято».
 *
 * Не WebAudio: первый new AudioContext() синхронно поднимает аудиосервис (250–600 мс главного потока, docs/SMOOTH-UI.md
 * §5) — и это пришлось бы на нажатие «Позвонить». Поэтому ноты считаются в PCM один раз (WAV в Blob URL) и играют
 * через <audio>: play() возвращается сразу, вывод — вне главного потока, динамик выбирается setSinkId.
 */

type Note = { f: number[]; at: number; dur: number };
type Tone = { notes: Note[]; period: number };   // period — длина файла (с тишиной после нот), повтор — loop

const RATE = 22050;

const TONES: Record<string, Tone> = {
  ringback: { notes: [{ f: [425], at: 0, dur: 1 }], period: 4 },
  busy: { notes: [{ f: [425], at: 0, dur: 0.35 }], period: 0.7 },
  connected: { notes: [{ f: [880], at: 0, dur: 0.12 }, { f: [1320], at: 0.14, dur: 0.16 }], period: 0.35 },
  ended: { notes: [{ f: [480], at: 0, dur: 0.18 }, { f: [360], at: 0.22, dur: 0.3 }], period: 0.6 },
  test: { notes: [{ f: [440], at: 0, dur: 0.25 }, { f: [554], at: 0.3, dur: 0.25 }, { f: [659], at: 0.6, dur: 0.4 }], period: 1.05 },
  'ring:classic': { notes: [{ f: [660, 880], at: 0, dur: 0.4 }, { f: [660, 880], at: 0.6, dur: 0.4 }], period: 2.5 },
  'ring:chime': { notes: [{ f: [784], at: 0, dur: 0.25 }, { f: [988], at: 0.25, dur: 0.25 }, { f: [1175], at: 0.5, dur: 0.45 }], period: 2.5 },
  'ring:pulse': { notes: [{ f: [523], at: 0, dur: 0.15 }, { f: [523], at: 0.25, dur: 0.15 }, { f: [523], at: 0.5, dur: 0.15 }, { f: [698], at: 0.75, dur: 0.35 }], period: 2.5 },
};

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

const urls = new Map<string, string>();
function url(name: string): string {
  let u = urls.get(name);
  if (!u) { u = URL.createObjectURL(new Blob([renderWav(TONES[name])], { type: 'audio/wav' })); urls.set(name, u); }
  return u;
}

let el: HTMLAudioElement | null = null;
let sink: string | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

function play(name: string, volume: number, loop: boolean, stopAfterMs = 0): void {
  if (typeof Audio === 'undefined' || !TONES[name]) return;
  stopNow();
  el ??= new Audio();
  el.src = url(name);
  el.loop = loop;
  el.volume = Math.max(0, Math.min(1, volume));
  const e = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  void (e.setSinkId ? e.setSinkId(sink ?? '').catch(() => {}) : Promise.resolve()).then(() => e.play().catch(() => {}));
  if (stopAfterMs) stopTimer = setTimeout(stopNow, stopAfterMs);
}

function stopNow(): void {
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (el) { el.pause(); el.currentTime = 0; }
}

/** Выход для звуков звонка (динамик из настроек; null — системный). */
export async function soundSink(deviceId: string | null): Promise<void> { sink = deviceId; }

/** Заранее посчитать звуки (в простое после загрузки): первый звонок не ждёт синтеза. */
export function warmCallSounds(): void { for (const k of Object.keys(TONES)) url(k); }

export const sounds = {
  ringback(volume: number): void { play('ringback', volume, true); },
  ringtone(name: string, volume: number): void { play('ring:' + (TONES['ring:' + name] ? name : 'classic'), volume, true); },
  preview(name: string, volume: number): void { play('ring:' + (TONES['ring:' + name] ? name : 'classic'), volume, false); },
  test(volume: number): void { play('test', volume, false); },
  connected(volume: number): void { play('connected', volume, false); },
  ended(volume: number): void { play('ended', volume, false); },
  busy(volume: number): void { play('busy', volume, true, 3000); },
  stop(): void { stopNow(); },
};
