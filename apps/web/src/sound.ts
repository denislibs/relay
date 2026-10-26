// Звуки сообщений — файлы, выбранные владельцем проекта: /sounds/message.mp3 (пришло) и /sounds/sent.mp3 (отправил сам).
// Играют через <audio> с нужной громкостью; файл не проигрался — у входящего запасной синтезированный «колокольчик»
// из двух нот (WebAudio), у отправки — тишина. Звучит, только если браузер разрешил аудио.
//
// Почему не WebAudio для файлов: первый `new AudioContext()` на странице синхронно поднимает аудиосервис браузера —
// 230–260 мс главного потока в замере (до 600–730 мс в обычном Chrome), и всё это внутри нажатия «Отправить»
// первого сообщения. <audio>.play() возвращается за доли миллисекунды, а вывод заводится вне главного потока.
// Чтобы и первый звук не опаздывал (~300 мс на холодном аудиосервисе), warmSounds() в простое после загрузки
// проигрывает оба файла без звука (не пустили без жеста — на первом нажатии).
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  const Ctor: typeof AudioContext | undefined = typeof AudioContext !== 'undefined' ? AudioContext : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

const SENT = '/sounds/sent.mp3', MESSAGE = '/sounds/message.mp3';
const players = new Map<string, HTMLAudioElement>();
function player(url: string): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  let a = players.get(url);
  if (!a) { a = new Audio(url); a.preload = 'auto'; players.set(url, a); }
  return a;
}
/**
 * Проиграть файл с начала. 'blocked' — браузер не разрешил звук без жеста (запасной звук тоже не прозвучит, а
 * AudioContext ради него — та же долгая задача), 'failed' — нет файла или аудио.
 */
function playFile(url: string, volume: number): Promise<'ok' | 'blocked' | 'failed'> {
  try {
    const a = player(url);
    if (!a) return Promise.resolve('failed');
    a.muted = false;
    a.volume = Math.min(1, volume);
    a.currentTime = 0;
    return a.play().then(() => 'ok' as const, (e: unknown) => ((e as { name?: string })?.name === 'NotAllowedError' ? 'blocked' : 'failed'));
  } catch { return Promise.resolve('failed'); }
}

/**
 * Заранее завести вывод звука (без звука): тогда первый настоящий звук не опаздывает. Беззвучное <audio> браузер
 * иногда не пускает без жеста (NotAllowedError) — тогда повторяем на первом нажатии: обычно это клик по чату или
 * полю ввода, задолго до «Отправить».
 */
let armed = false;
export function warmSounds(): void {
  for (const url of [SENT, MESSAGE]) {
    try {
      const a = player(url);
      if (!a || !a.paused) continue;
      a.muted = true;
      // настоящий звук успел начаться поверх прогрева (он снимает muted) — его не трогаем
      void a.play().then(() => { if (a.muted) { a.pause(); a.currentTime = 0; } }, () => { if (a.muted) armWarm(); })
        .finally(() => { a.muted = false; });
    } catch { /* аудио недоступно — не страшно */ }
  }
}
function armWarm(): void {
  if (armed || typeof addEventListener !== 'function') return;
  armed = true;
  const go = () => { removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true); armed = false; warmSounds(); };
  addEventListener('pointerdown', go, true);
  addEventListener('keydown', go, true);
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

/** Своё сообщение ушло — короткий «щелчок». volume 0..1; 0 — ничего не играем. */
export function playSentSound(volume: number): void {
  if (!(volume > 0)) return;
  void playFile(SENT, volume);
}

/** Уведомление о новом сообщении. volume 0..1; 0 — ничего не играем. */
export function playNotifySound(volume: number): void {
  if (!(volume > 0)) return;
  void playFile(MESSAGE, volume).then((r) => {
    if (r !== 'failed') return;
    try { const c = audio(); if (c) playChime(c, volume); } catch { /* аудио недоступно — не страшно */ }
  });
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
