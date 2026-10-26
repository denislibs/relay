import { beforeEach, expect, test } from 'bun:test';

// Подделки <audio> и WebAudio: проверяем, что обычный звук не создаёт AudioContext (его конструктор при первом
// звуке страницы синхронно поднимает аудиосервис браузера — 230–600 мс главного потока на первой отправке).
let created: FakeAudio[] = [];
let contexts = 0;
class FakeAudio {
  src: string; preload = ''; muted = false; volume = 1; currentTime = 0; plays: { muted: boolean; volume: number }[] = []; paused = true;
  static fail: false | string = false;
  constructor(src: string) { this.src = src; created.push(this); }
  play(): Promise<void> {
    this.plays.push({ muted: this.muted, volume: this.volume });
    if (FakeAudio.fail) { const e = new Error('fail'); e.name = FakeAudio.fail; return Promise.reject(e); }
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void { this.paused = true; }
}
class FakeContext {
  state = 'running'; currentTime = 0; destination = {};
  constructor() { contexts++; }
  resume() { return Promise.resolve(); }
  private node() { const n = { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, frequency: { value: 0 }, delayTime: { value: 0 }, connect: (x: unknown) => x ?? n, start() {}, stop() {}, type: '' }; return n; }
  createGain() { return this.node(); }
  createOscillator() { return this.node(); }
  createBiquadFilter() { return this.node(); }
  createDelay() { return this.node(); }
}
const g = globalThis as Record<string, unknown>;
g.Audio = FakeAudio;
g.AudioContext = FakeContext;
const { playSentSound, playNotifySound, warmSounds } = await import('./sound');
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { FakeAudio.fail = false; contexts = 0; for (const a of created) { a.plays.length = 0; a.paused = true; } });

test('sent sound: an <audio> element at the chosen volume, no AudioContext', async () => {
  playSentSound(0.3);
  await tick();
  const a = created.find((x) => x.src === '/sounds/sent.mp3')!;
  expect(a.plays).toEqual([{ muted: false, volume: 0.3 }]);
  expect(contexts).toBe(0);
  playSentSound(0.7);   // тот же элемент, с начала
  await tick();
  expect(created.filter((x) => x.src === '/sounds/sent.mp3').length).toBe(1);
  expect(a.plays.at(-1)).toEqual({ muted: false, volume: 0.7 });
});

test('volume 0 plays nothing; volume above 1 is clamped', async () => {
  playNotifySound(0);
  playSentSound(1.5);
  await tick();
  expect(created.find((x) => x.src === '/sounds/message.mp3')?.plays.length ?? 0).toBe(0);
  expect(created.find((x) => x.src === '/sounds/sent.mp3')!.plays.at(-1)?.volume).toBe(1);
});

test('warmSounds: muted play of both sounds (starts the audio pipeline off the main thread), then unmuted and paused', async () => {
  warmSounds();
  await tick();
  for (const src of ['/sounds/sent.mp3', '/sounds/message.mp3']) {
    const a = created.find((x) => x.src === src)!;
    expect(a.plays.at(-1)?.muted).toBe(true);
    expect(a.muted).toBe(false);
    expect(a.paused).toBe(true);
  }
  expect(contexts).toBe(0);
});

test('a real sound started during the warm-up is not paused by it', async () => {
  warmSounds();
  playSentSound(0.5);   // до того, как прогрев успел завершиться
  await tick();
  const a = created.find((x) => x.src === '/sounds/sent.mp3')!;
  expect(a.plays.map((p) => p.muted)).toEqual([true, false]);
  expect(a.paused).toBe(false);
  expect(a.muted).toBe(false);
});

test('warm-up refused without a user gesture is retried on the first pointerdown', async () => {
  const listeners = new Map<string, () => void>();
  const add = g.addEventListener, remove = g.removeEventListener;
  g.addEventListener = (t: string, fn: () => void) => { listeners.set(t, fn); };
  g.removeEventListener = (t: string) => { listeners.delete(t); };
  FakeAudio.fail = 'NotAllowedError';
  warmSounds();
  await tick();
  expect([...listeners.keys()].sort()).toEqual(['keydown', 'pointerdown']);
  FakeAudio.fail = false;
  listeners.get('pointerdown')!();
  await tick();
  expect(listeners.size).toBe(0);
  const a = created.find((x) => x.src === '/sounds/sent.mp3')!;
  expect(a.plays.map((p) => p.muted)).toEqual([true, true]);
  expect(a.paused).toBe(true);
  expect(a.muted).toBe(false);
  g.addEventListener = add; g.removeEventListener = remove;
});

test('notify sound falls back to the synthesized chime only when the file cannot play', async () => {
  FakeAudio.fail = 'NotAllowedError';   // звук ещё не разрешён (нет жеста) — без AudioContext: молча
  playNotifySound(0.5);
  await tick(); await tick();
  expect(contexts).toBe(0);
  FakeAudio.fail = 'NotSupportedError';
  playSentSound(0.5);   // у отправки запасного звука нет — тишина
  await tick(); await tick();
  expect(contexts).toBe(0);
  playNotifySound(0.5);
  await tick(); await tick();
  expect(contexts).toBe(1);
});
