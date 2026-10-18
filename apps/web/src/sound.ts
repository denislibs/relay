// Звук нового сообщения — файл /sounds/message.mp3 (выбран владельцем проекта), декодируется один раз и играет
// через WebAudio с нужной громкостью. Файл не загрузился — запасной синтезированный «колокольчик» из двух нот.
// Звучит, только если браузер разрешил аудио.
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  const Ctor: typeof AudioContext | undefined = typeof AudioContext !== 'undefined' ? AudioContext : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Одна нота «колокольчика»: основной тон + октава + «стеклянный» обертон (×2.76, как у металлофона), у обертонов
 * хвост короче — удар звонкий, а остаётся мягкий тон. Огибающая без щелчков (атака 4 мс).
 */
function chime(c: AudioContext, out: AudioNode, hz: number, at: number, peak: number, length: number): void {
  const partials: [ratio: number, level: number, decay: number][] = [[1, 1, length], [2, 0.32, length * 0.55], [2.76, 0.16, length * 0.3], [5.4, 0.05, 0.06]];
  for (const [ratio, level, decay] of partials) {
    const osc = c.createOscillator(), gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz * ratio;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * level), at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + decay + 0.02);
  }
}

const SOUND_URL = '/sounds/message.mp3';
let buffer: Promise<AudioBuffer | null> | null = null;
function messageBuffer(c: AudioContext): Promise<AudioBuffer | null> {
  buffer ??= fetch(SOUND_URL).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then((data) => c.decodeAudioData(data))
    .catch(() => { buffer = null; return null; });   // в следующий раз попробуем снова
  return buffer;
}

/** Уведомление о новом сообщении. volume 0..1; 0 — ничего не играем. */
export function playNotifySound(volume: number): void {
  if (!(volume > 0)) return;
  try {
    const c = audio();
    if (!c) return;
    void messageBuffer(c).then((buf) => {
      if (!buf) { playChime(c, volume); return; }
      const src = c.createBufferSource(), gain = c.createGain();
      src.buffer = buf;
      gain.gain.value = Math.min(1, volume);
      src.connect(gain).connect(c.destination);
      src.start();
    }, () => playChime(c, volume));
  } catch { /* аудио недоступно — не страшно */ }
}

/** Запасной звук без файла: две ноты вверх (си → ми), ~0.5 с. */
function playChime(c: AudioContext, volume: number): void {
  try {
    const t = c.currentTime + 0.01;
    // общий выход: мягкий срез верхов (без «писка») и тихое эхо — звук не сухой
    const master = c.createGain();
    master.gain.value = Math.min(1, volume) * 0.32;   // полная громкость не бьёт по ушам
    const tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 5200;
    const echo = c.createDelay(0.5), echoGain = c.createGain();
    echo.delayTime.value = 0.11;
    echoGain.gain.value = 0.18;
    tone.connect(master);
    tone.connect(echo).connect(echoGain).connect(master);
    master.connect(c.destination);
    chime(c, tone, 987.77, t, 0.9, 0.42);          // си второй октавы
    chime(c, tone, 1318.51, t + 0.085, 1, 0.55);   // ми третьей — чуть громче и длиннее, «точка»
  } catch { /* аудио недоступно — не страшно */ }
}
