import type { Prefs } from '../prefs';

/**
 * Микрофон и камера для звонка и страницы настроек. Сохранённое устройство пропало (отключили) — берём системное
 * и говорим об этом вызывающему (fellBack). Захват — только по действию пользователя; кто взял поток, тот и
 * останавливает (stopStream).
 */

type CallPrefs = Prefs['calls'];

const VIDEO: Record<CallPrefs['video'], MediaTrackConstraints> = {
  auto: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
  saver: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 24 } },
  high: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
};

/** Предел битрейта видео (бит/с) — для параметров отправителя. */
export const VIDEO_BITRATE: Record<CallPrefs['video'], number> = { auto: 1_500_000, saver: 500_000, high: 2_500_000 };

export const audioConstraints = (p: CallPrefs, withDevice = true): MediaTrackConstraints => ({
  ...(withDevice && p.mic ? { deviceId: { exact: p.mic } } : {}),
  echoCancellation: true,   // всегда: без него собеседник слышит себя
  noiseSuppression: p.noise,
  autoGainControl: p.agc,
});

export const videoConstraints = (p: CallPrefs, withDevice = true, facing?: 'user' | 'environment'): MediaTrackConstraints => ({
  ...(withDevice && p.camera ? { deviceId: { exact: p.camera } } : facing ? { facingMode: facing } : {}),
  ...VIDEO[p.video],
});

export type MediaFailure = 'denied' | 'missing' | 'busy' | 'insecure' | 'unknown';

export function failureOf(e: unknown): MediaFailure {
  const name = (e as { name?: string })?.name;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return 'insecure';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'unknown';
}

/** Один вид дорожки: выбранное устройство, а если его нет — системное. */
async function grab(kind: 'audio' | 'video', p: CallPrefs): Promise<{ track: MediaStreamTrack; fellBack: boolean }> {
  const md = navigator.mediaDevices;
  const want = kind === 'audio' ? audioConstraints(p) : videoConstraints(p);
  try {
    const s = await md.getUserMedia({ [kind]: want });
    return { track: s.getTracks()[0], fellBack: false };
  } catch (e) {
    const chosen = kind === 'audio' ? p.mic : p.camera;
    if (!chosen || failureOf(e) !== 'missing') throw e;
    const s = await md.getUserMedia({ [kind]: kind === 'audio' ? audioConstraints(p, false) : videoConstraints(p, false) });
    return { track: s.getTracks()[0], fellBack: true };
  }
}

export async function getMic(p: CallPrefs) { return grab('audio', p); }
export async function getCamera(p: CallPrefs) { return grab('video', p); }

export function stopStream(s: MediaStream | null | undefined): void {
  for (const t of s?.getTracks() ?? []) t.stop();
}

/** Устройства по видам; названия браузер отдаёт только после разрешения — иначе «Микрофон 1». */
export async function listDevices(): Promise<{ mic: MediaDeviceInfo[]; speaker: MediaDeviceInfo[]; camera: MediaDeviceInfo[] }> {
  const all = (await navigator.mediaDevices?.enumerateDevices().catch(() => [])) ?? [];
  const real = (d: MediaDeviceInfo) => d.deviceId !== 'default' && d.deviceId !== 'communications' && d.deviceId !== '';
  return {
    mic: all.filter((d) => d.kind === 'audioinput' && real(d)),
    speaker: all.filter((d) => d.kind === 'audiooutput' && real(d)),
    camera: all.filter((d) => d.kind === 'videoinput' && real(d)),
  };
}

/** Можно ли выбрать выход звука (setSinkId есть не везде). */
export const canPickSpeaker = (): boolean => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

/** Уровень громкости дорожки 0..1 — для индикатора микрофона; stop() отпускает анализатор (не дорожку). */
export function levelMeter(track: MediaStreamTrack, onLevel: (v: number) => void): { stop(): void } {
  const c = new AudioContext();
  const src = c.createMediaStreamSource(new MediaStream([track]));
  const an = c.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let raf = 0;
  const tick = () => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
    raf = requestAnimationFrame(tick);
  };
  tick();
  return { stop() { cancelAnimationFrame(raf); src.disconnect(); void c.close().catch(() => {}); } };
}
