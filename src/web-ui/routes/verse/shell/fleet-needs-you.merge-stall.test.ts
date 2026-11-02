import { describe, expect, it } from 'vitest';
import { deriveMergeStallNotification } from '../../../components/notifications/deriveMergeStallNotification.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { deriveFleetNeedsYou } from './fleet-needs-you.js';

const now = Date.parse('2026-11-01T04:10:00Z');
const publishes = [5, 10, 15, 20].map((minutes, i) => ({
  job: `job-${i + 1}`, lane: 'codex', url: null, at: new Date(now - minutes * 60_000).toISOString(),
}));
const snapshot: FleetRuns = {
  v: 1, generatedAt: new Date(now).toISOString(),
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: new Date(now).toISOString(), paused: false, memFreePct: 50, diskFreeGb: 80,
  switches: [], claudeLane: null, lanes: [], workers: [], leaders: [{ label: 'leader', ageSeconds: 30 }],
  orchestratorAgents: 1, publishesLastHour: publishes, mergesLastHour: { count: 0, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null,
};
const stall = (data: FleetRuns) => deriveFleetNeedsYou(data, now).items.filter(item => item.id === 'merge-stall');

describe('merge stall in Needs you', () => {
  it('reports one urgent item with the three newest publishes and a merges link', () => {
    expect(stall({ ...snapshot, publishesLastHour: [...publishes].reverse() })).toEqual([{
      id: 'merge-stall', severity: 'urgent',
      title: 'Merge gate stalled: 4 published, 0 merged in the last hour',
      detail: 'job-1 (5m ago) · job-2 (10m ago) · job-3 (15m ago)',
      nextStep: 'Check the merge gate in Fleet ▸ Merges',
      open: { kind: 'pane', paneId: 'fleet-merges' }, target: 'fleet',
    }]);
  });

  it.each([
    { ...snapshot, mergesLastHour: { count: 1, items: [] } },
    { ...snapshot, publishesLastHour: publishes.slice(0, 2) },
    { ...snapshot, sources: { ...snapshot.sources, merges: 'degraded' as const } },
  ])('clears without evidence of a stall', data => expect(stall(data)).toEqual([]));

  it('preserves the bell notification object', () => {
    expect(deriveMergeStallNotification(snapshot, now)).toEqual([{
      id: `merge-stall:${Math.floor(now / 3_600_000)}`, category: 'fleet', severity: 'critical',
      title: 'Merge gate stalled: 4 published, 0 merged in the last hour',
      detail: 'job-1 (5m ago) · job-2 (10m ago) · job-3 (15m ago)',
      ts: '2026-11-01T04:10:00.000Z', actionLabel: 'Open merges',
      actionHref: new URL('/verse/?pane=fleet-merges', window.location.href).toString(),
    }]);
  });
});
