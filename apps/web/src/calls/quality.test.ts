import { expect, test } from 'bun:test';
import { levelOf, pathOf, sampleOf, smoother, videoCap } from './quality';

test('level by loss, delay and jitter', () => {
  expect(levelOf({ loss: 0, rtt: 40, jitter: 5 })).toBe(3);
  expect(levelOf({ loss: 0.03, rtt: 40, jitter: 5 })).toBe(2);
  expect(levelOf({ loss: 0, rtt: 700, jitter: 5 })).toBe(1);
  expect(levelOf({ loss: 0.2, rtt: 40, jitter: 5 })).toBe(0);
});

test('smoothing: down after two bad samples, up after three good ones — no flicker', () => {
  const s = smoother();
  expect([3, 1, 3, 1, 1].map(s)).toEqual([3, 3, 3, 3, 1]);
  expect([3, 3].map(s)).toEqual([1, 1]);
  expect(s(3)).toBe(3);
});

test('video cap tightens with the level', () => {
  expect(videoCap(3, 1_500_000)).toEqual({ maxBitrate: 1_500_000, scale: 1 });
  expect(videoCap(1, 1_500_000).maxBitrate).toBe(250_000);
  expect(videoCap(0, 1_500_000).scale).toBe(4);
});

test('sample from getStats: receive loss is a delta since the previous sample, send loss from the peer report', () => {
  const prev = { lost: 0, recv: 0 };
  sampleOf([{ type: 'inbound-rtp', packetsLost: 10, packetsReceived: 990 }], prev);
  const s = sampleOf([
    { type: 'inbound-rtp', packetsLost: 30, packetsReceived: 1170, jitter: 0.012 },
    { type: 'remote-inbound-rtp', fractionLost: 0.01, roundTripTime: 0.08 },
    { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.09 },
  ], prev);
  expect(s.loss).toBeCloseTo(20 / 200);
  expect(s.rtt).toBeCloseTo(90);
  expect(s.jitter).toBeCloseTo(12);
});

test('call path: the selected candidate pair decides direct vs relayed via TURN', () => {
  const report = (rows: Record<string, unknown>[]) => { const m = new Map(rows.map((r) => [r.id as string, r])); return { forEach: (fn: (r: Record<string, unknown>) => void) => m.forEach((r) => fn(r)), get: (id: string) => m.get(id) }; };
  const direct = report([
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P1' },
    { id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1' },
    { id: 'L1', type: 'local-candidate', candidateType: 'srflx' }, { id: 'R1', type: 'remote-candidate', candidateType: 'host' },
  ]);
  expect(pathOf(direct)).toBe('direct');
  // Firefox: без selectedCandidatePairId — по выбранной (nominated, succeeded) паре
  const relayed = report([
    { id: 'P0', type: 'candidate-pair', nominated: false, state: 'failed', localCandidateId: 'L0', remoteCandidateId: 'R1' },
    { id: 'P1', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L1', remoteCandidateId: 'R1' },
    { id: 'L0', type: 'local-candidate', candidateType: 'host' }, { id: 'L1', type: 'local-candidate', candidateType: 'relay' }, { id: 'R1', type: 'remote-candidate', candidateType: 'srflx' },
  ]);
  expect(pathOf(relayed)).toBe('relay');
  expect(pathOf(report([]))).toBeNull();
});
