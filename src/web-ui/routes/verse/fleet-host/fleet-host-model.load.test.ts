import { expect, it } from 'vitest';
import { isFleetRuns } from '../ops/ops-runs-model.js';
import { hostView } from './fleet-host-model.js';

const snapshot = {
  v: 1, generatedAt: '', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: false, memFreePct: 40, diskFreeGb: 30, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const host = { load1: 194, load5: 180, load15: 160, cores: 18, ratio: 10.8 };

it('validates host readings and classifies load thresholds', () => {
  for (const [ratio, tone] of [[null, 'unknown'], [1.49, 'ok'], [1.5, 'warn'], [3.99, 'warn'], [4, 'bad'], [10.8, 'bad']] as const) {
    const value = { ...snapshot, host: { ...host, ratio } };
    if (!isFleetRuns(value)) throw new Error('valid snapshot rejected');
    expect(hostView(value, 0).load.tone).toBe(tone);
  }
  const value = { ...snapshot, host };
  if (!isFleetRuns(value)) throw new Error('valid snapshot rejected');
  expect(hostView(value, 0).load).toEqual({ ratio: 10.8, text: 'Load 194 on 18 cores (10.8×)', caption: 'bad', tone: 'bad' });
  expect(isFleetRuns({ ...snapshot, host: { ...host, ratio: '10.8' } })).toBe(false);
  expect(isFleetRuns({ ...snapshot, host: { ...host, ratio: NaN } })).toBe(false);
});
it('accepts older snapshots and null host readings', () => {
  expect(isFleetRuns(snapshot)).toBe(true);
  expect(isFleetRuns({ ...snapshot, host: null })).toBe(true);
  expect(hostView(null, 0).load).toEqual({ ratio: null, text: 'Load unknown', caption: 'Unknown', tone: 'unknown' });
});
