import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { deriveFleetNeedsYou } from './fleet-needs-you.js';

const NOW = Date.parse('2026-11-04T00:00:00Z');

function snapshot(): FleetRuns {
  return {
    v: 1, generatedAt: new Date(NOW).toISOString(),
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: new Date(NOW).toISOString(), paused: false, memFreePct: 50, diskFreeGb: 80,
    switches: [], claudeLane: null,
    lanes: [{ lane: 'codex-personal', running: 1, target: 2, queued: 3, held: false, heldReason: null, tokensLastHour: 0, merged24h: 0, mergeRate24h: 0 }],
    workers: [], leaders: [{ label: 'leader', ageSeconds: 30 }], orchestratorAgents: 1,
    publishesLastHour: [], mergesLastHour: { count: 1, items: [] }, events: [],
    codexPersonal: { usedPct: 89, resetsAt: '2026-11-04T01:41:00Z', asOf: new Date(NOW).toISOString() },
    inbox: [], drop: null,
  };
}

describe('idle lanes and pending drops in Needs you', () => {
  it('reports an idle lane with queued work and opens Lanes', () => {
    const runs = snapshot();
    Object.assign(runs.lanes[0]!, { running: 0, target: 24, queued: 7 });
    expect(deriveFleetNeedsYou(runs, NOW)).toEqual({ answered: true, items: [{
      id: 'lane-idle:codex-personal', open: { kind: 'pane', paneId: 'fleet-lanes' },
      severity: 'attention', title: 'Lane codex-personal is idle',
      detail: '7 queued jobs but nothing is running.',
      nextStep: 'Lane codex-personal has 7 queued and nothing running; check its hold and target in Lanes',
      target: 'fleet',
    }] });
  });

  it('does not flag a held, running, disabled, or empty lane as idle', () => {
    for (const change of [{ held: true }, { running: 1 }, { target: 0 }, { queued: 0 }]) {
      const runs = snapshot();
      Object.assign(runs.lanes[0]!, { running: 0, target: 24, queued: 7 }, change);
      expect(deriveFleetNeedsYou(runs, NOW).items.some((item) => item.id.startsWith('lane-idle:'))).toBe(false);
    }
  });

  it('reports each idle lane separately', () => {
    const runs = snapshot();
    Object.assign(runs.lanes[0]!, { running: 0, target: 24, queued: 7 });
    runs.lanes.push({ ...runs.lanes[0]!, lane: 'fake-lane', queued: 2 });
    expect(deriveFleetNeedsYou(runs, NOW).items.map((item) => item.id)).toEqual([
      'lane-idle:codex-personal', 'lane-idle:fake-lane',
    ]);
  });

  it('reports pending drop files and opens the leader journal', () => {
    const runs = snapshot();
    runs.drop = { pending: [{ lane: 'fake-lane', file: 'fake-one.json' }, { lane: 'fake-lane', file: 'fake-two.json' }], done: 0 };
    expect(deriveFleetNeedsYou(runs, NOW).items).toEqual([{
      id: 'drop-pending', open: { kind: 'pane', paneId: 'leader-journal' },
      severity: 'attention', title: 'Leader jobs awaiting ingest', detail: '2 pending drop files.',
      nextStep: '2 pending drop files; ingest sweeps every few minutes', target: 'ops',
    }]);
    runs.drop.pending.pop();
    expect(deriveFleetNeedsYou(runs, NOW).items[0]?.nextStep).toBe('1 pending drop file; ingest sweeps every few minutes');
    runs.drop.pending.pop();
    expect(deriveFleetNeedsYou(runs, NOW).items).toEqual([]);
  });

  it('leaves the healthy snapshot unchanged', () => {
    expect(deriveFleetNeedsYou(snapshot(), NOW)).toEqual({ answered: true, items: [] });
  });
});
