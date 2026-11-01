import { expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { fleetAttention } from './needs-fleet-model.js';

it('offers the merge stall on the phone with an action to Fleet', () => {
  const now = Date.parse('2026-11-01T04:10:00Z');
  const snapshot: FleetRuns = {
    v: 1, generatedAt: new Date(now).toISOString(),
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: new Date(now).toISOString(), paused: false, memFreePct: 50, diskFreeGb: 80,
    switches: [], claudeLane: null, lanes: [], workers: [], leaders: [{ label: 'leader', ageSeconds: 30 }],
    orchestratorAgents: 1,
    publishesLastHour: [5, 10, 15, 20].map((minutes, i) => ({
      job: `job-${i + 1}`, lane: 'codex', url: null, at: new Date(now - minutes * 60_000).toISOString(),
    })),
    mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
  };
  expect(fleetAttention(snapshot, now).filter(item => item.id === 'merge-stall')).toEqual([{
    id: 'merge-stall', severity: 'high', title: 'Merge gate stalled: 4 published, 0 merged in the last hour',
    detail: 'job-1 (5m ago) · job-2 (10m ago) · job-3 (15m ago)',
    next: 'Check the merge gate in Fleet ▸ Merges',
    action: { kind: 'screen', screen: 'fleet', label: 'Open fleet' },
  }]);
});
