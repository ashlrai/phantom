import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { deriveFleetNeedsYou, diskLowSeverity } from './fleet-needs-you.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');

function snapshot(over: Partial<FleetRuns> = {}): FleetRuns {
  return {
    v: 1,
    generatedAt: '2026-10-31T12:00:00Z',
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: '2026-10-31T11:59:00Z',
    paused: false,
    memFreePct: 50,
    diskFreeGb: 50,
    switches: [],
    claudeLane: null,
    lanes: [{ lane: 'codex-cmp', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: 100, merged24h: 2, mergeRate24h: 50 }],
    workers: [{ job: 'job-one', repo: 'phantom', lane: 'codex-cmp', tier: 'frontier', ageSeconds: 120 }],
    leaders: [{ label: 'leader', ageSeconds: 30 }],
    orchestratorAgents: 1,
    publishesLastHour: [],
    mergesLastHour: { count: 1, items: [{ repo: 'phantom', number: 12, title: 'Fleet view' }] },
    events: [{ at: '2026-10-31T11:55:00Z', kind: 'worker-start', text: 'started job-one' }],
    codexPersonal: null,
    inbox: [],
    drop: null,
    ...over,
  };
}

const diskRow = (value: unknown) => deriveFleetNeedsYou(value, NOW).items.find((item) => item.id === 'host-disk-low');

describe('fleet disk needs-you row', () => {
  it('does not warn when 50 GB is free', () => {
    expect(diskRow(snapshot())).toBeUndefined();
  });

  it('warns at 12 GB and opens the Host pane', () => {
    expect(diskRow(snapshot({ diskFreeGb: 12 }))).toEqual({
      id: 'host-disk-low',
      severity: 'attention',
      title: 'Disk is nearly full on this Mac',
      detail: '12 GB free. Workers clone repos and write logs here; a full disk halts every lane.',
      nextStep: 'Free space: empty ~/.ashlr-runs/archive and old worker clones, then recheck in the Host pane.',
      target: 'ops',
      open: { kind: 'pane', paneId: 'fleet-host' },
    });
  });

  it('marks 3 GB as urgent', () => {
    expect(diskRow(snapshot({ diskFreeGb: 3 }))).toMatchObject({
      severity: 'urgent', title: 'Disk is critically full on this Mac', detail: expect.stringContaining('3 GB free'),
    });
  });

  it('does not warn when the disk reading is unknown or missing', () => {
    expect(diskRow(snapshot({ diskFreeGb: null }))).toBeUndefined();
    const { diskFreeGb: _diskFreeGb, ...missingDisk } = snapshot();
    expect(diskRow(missingDisk)).toBeUndefined();
  });

  it('uses the Host pane thresholds at their boundaries', () => {
    expect(diskLowSeverity(null)).toBeNull();
    expect(diskLowSeverity(20)).toBeNull();
    expect(diskLowSeverity(19.9)).toBe('warning');
    expect(diskLowSeverity(5)).toBe('warning');
    expect(diskLowSeverity(4.9)).toBe('danger');
  });
});
