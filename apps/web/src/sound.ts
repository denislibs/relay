// Короткий сигнал уведомления, сгенерированный WebAudio (без файлов). Звучит, только если браузер разрешил аудио.
let ctx: AudioContext | null = null;

/** Два тона по 120 мс. volume 0..1; 0 — ничего не играем. */
export function playNotifySound(volume: number): void {
  if (!(volume > 0)) return;
  try {
    const Ctor: typeof AudioContext | undefined = typeof AudioContext !== 'undefined' ? AudioContext : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const t = ctx.currentTime;
    for (const [i, hz] of [880, 1318.5].entries()) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const at = t + i * 0.12;
      // огибающая без щелчков; потолок 0.4 — полная громкость не бьёт по ушам
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.4), at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.13);
    }
  } catch { /* аудио недоступно — не страшно */ }
}
