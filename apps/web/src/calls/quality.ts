/**
 * Качество связи в звонке (этап 5 docs/plans/2026-11-07-relay-calls-features.md): уровень 0–3 по потерям, задержке и
 * дрожанию; плашки «Плохое соединение» / «Слабый сигнал у …» и потолок видео по уровню. Плашка не мигает: вниз — после
 * двух плохих замеров подряд, вверх — после трёх хороших.
 */

/** 3 — хорошо, 2 — терпимо, 1 — плохо (плашка, видео хуже), 0 — очень плохо (видео собеседника на паузу). */
export type NetLevel = 0 | 1 | 2 | 3;

export type NetSample = { loss: number; rtt: number; jitter: number };   // loss 0..1, rtt и jitter — мс

export function levelOf(s: NetSample): NetLevel {
  if (s.loss >= 0.15 || s.rtt >= 1200) return 0;
  if (s.loss >= 0.06 || s.rtt >= 600 || s.jitter >= 80) return 1;
  if (s.loss >= 0.02 || s.rtt >= 300 || s.jitter >= 40) return 2;
  return 3;
}

/** Сглаживание: уровень меняется, только когда новый держится DOWN (хуже) или UP (лучше) замеров подряд. */
export function smoother(down = 2, up = 3): (l: NetLevel) => NetLevel {
  let shown: NetLevel = 3, cand: NetLevel = 3, n = 0;
  return (l) => {
    if (l === shown) { n = 0; cand = l; return shown; }
    if (l !== cand) { cand = l; n = 0; }
    n++;
    if (n >= (l < shown ? down : up)) { shown = l; n = 0; }
    return shown;
  };
}

/** Потолок видео по уровню (поверх настройки «Качество видео»): битрейт и уменьшение кадра. */
export function videoCap(level: NetLevel, base: number): { maxBitrate: number; scale: number } {
  if (level >= 3) return { maxBitrate: base, scale: 1 };
  if (level === 2) return { maxBitrate: Math.round(base * 0.6), scale: 1.5 };
  if (level === 1) return { maxBitrate: Math.min(base, 250_000), scale: 2 };
  return { maxBitrate: 120_000, scale: 4 };
}

type Stat = { type: string; kind?: string; packetsLost?: number; packetsReceived?: number; jitter?: number; roundTripTime?: number; fractionLost?: number; currentRoundTripTime?: number; state?: string; nominated?: boolean };

/**
 * Замер по getStats соединения: потери на приёме (дельта с прошлого замера) и на отправке (отчёт собеседника),
 * задержка — пара ICE; берётся худшее направление. prev — счётчики прошлого замера (меняется на месте).
 */
export function sampleOf(stats: Iterable<Stat>, prev: { lost: number; recv: number }): NetSample {
  let lost = 0, recv = 0, jitter = 0, rtt = 0, sendLoss = 0;
  for (const s of stats) {
    if (s.type === 'inbound-rtp') { lost += s.packetsLost ?? 0; recv += s.packetsReceived ?? 0; jitter = Math.max(jitter, (s.jitter ?? 0) * 1000); }
    else if (s.type === 'remote-inbound-rtp') { sendLoss = Math.max(sendLoss, s.fractionLost ?? 0); rtt = Math.max(rtt, (s.roundTripTime ?? 0) * 1000); }
    else if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') rtt = Math.max(rtt, (s.currentRoundTripTime ?? 0) * 1000);
  }
  const dl = Math.max(0, lost - prev.lost), dr = Math.max(0, recv - prev.recv);
  prev.lost = lost; prev.recv = recv;
  const recvLoss = dl + dr > 0 ? dl / (dl + dr) : 0;
  return { loss: Math.max(recvLoss, sendLoss), rtt, jitter };
}

/** Каким путём идёт медиа: выбранная пара кандидатов, хоть один конец — relay (TURN). null — браузер не сказал. */
export function pathOf(stats: { forEach(fn: (r: Record<string, unknown>) => void): void; get(id: string): unknown }): 'direct' | 'relay' | null {
  let pairId = null as string | null;
  stats.forEach((r) => { if (r.type === 'transport' && typeof r.selectedCandidatePairId === 'string') pairId = r.selectedCandidatePairId; });
  if (!pairId) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pairId ??= r.id as string; });
  const pair = pairId ? stats.get(pairId) as Record<string, unknown> | undefined : undefined;
  if (!pair) return null;
  const local = stats.get(String(pair.localCandidateId)) as Record<string, unknown> | undefined;
  const remote = stats.get(String(pair.remoteCandidateId)) as Record<string, unknown> | undefined;
  if (!local && !remote) return null;
  return local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
}
