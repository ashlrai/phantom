import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { deriveFleetNeedsYou } from './fleet-needs-you.js';

const NOW = Date.parse('2026-11-04T00:00:00Z');
const RESET = '2026-11-04T01:41:00Z';
const localReset = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(RESET));

function snapshot(usedPct: number | null, queued = 3): FleetRuns {
  return {
    v: 1, generatedAt: new Date(NOW).toISOString(),
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: new Date(NOW).toISOString(), paused: false, memFreePct: 50, diskFreeGb: 80,
    switches: [], claudeLane: null,
    lanes: [{ lane: 'codex-personal', running: 1, target: 2, queued, held: false, heldReason: null, tokensLastHour: 0, merged24h: 0, mergeRate24h: 0 }],
    workers: [], leaders: [{ label: 'leader', ageSeconds: 30 }], orchestratorAgents: 1,
    publishesLastHour: [], mergesLastHour: { count: 1, items: [] }, events: [],
    codexPersonal: { usedPct, resetsAt: RESET, asOf: new Date(NOW).toISOString() },
    inbox: [], drop: null,
  };
}

function supply(runs: FleetRuns, now = NOW) {
  return deriveFleetNeedsYou(runs, now).items.filter((item) => item.id.startsWith('supply-personal-'));
}

describe('personal Codex supply in Needs you', () => {
  it('does not warn below 90%', () => {
    expect(supply(snapshot(89))).toEqual([]);
  });

  it('warns at 93% with the queue, estimated exhaustion and local reset', () => {
    expect(supply(snapshot(93))).toEqual([{
      id: 'supply-personal-low', severity: 'attention', title: 'Personal Codex is at 93%',
      detail: `3 jobs queued on codex-personal · out in about 105 min · resets ${localReset}`,
      nextStep: 'Move new work to Devin and local lanes before it runs out', target: 'fleet',
    }]);
  });

  it('counts elapsed time from the reading when estimating exhaustion', () => {
    expect(supply(snapshot(97), NOW + 5 * 60_000)[0]?.detail).toContain('out in about 40 min');
    expect(supply(snapshot(97), NOW + 60 * 60_000)[0]?.detail).toContain('out in about 0 min');
  });

  it('makes an exhausted lane urgent while jobs are queued', () => {
    expect(supply(snapshot(100))).toEqual([{
      id: 'supply-personal-out', severity: 'urgent', title: `Personal Codex is out until ${localReset}`,
      detail: '3 jobs are waiting on it',
      nextStep: 'Those jobs wait for the reset; the leaders should route new work elsewhere', target: 'fleet',
    }]);
  });

  it('makes an exhausted lane attention when no jobs are queued', () => {
    expect(supply(snapshot(100, 0))[0]).toMatchObject({ severity: 'attention', detail: '0 jobs are waiting on it' });
  });

  it('recognizes a usage or limit hold even when the reading is missing or low', () => {
    for (const reason of ['usage exhausted', 'Rate LIMIT reached']) {
      const runs = snapshot(93);
      runs.codexPersonal = null;
      runs.lanes[0]!.held = true;
      runs.lanes[0]!.heldReason = reason;
      expect(supply(runs)[0]).toMatchObject({ id: 'supply-personal-out', severity: 'urgent', title: 'Personal Codex is out' });
    }
    const runs = snapshot(93);
    runs.lanes[0]!.held = true;
    runs.lanes[0]!.heldReason = 'maintenance';
    expect(supply(runs)[0]?.id).toBe('supply-personal-low');
  });

  it('does not add a supply row without a personal reading or usage hold', () => {
    const runs = snapshot(93);
    runs.codexPersonal = null;
    expect(supply(runs)).toEqual([]);
  });

  it('omits unknown reset times for low and exhausted readings', () => {
    for (const used of [93, 100]) {
      const runs = snapshot(used);
      runs.codexPersonal!.resetsAt = null;
      const item = supply(runs)[0]!;
      expect(`${item.title} ${item.detail}`).not.toMatch(/reset|until/);
    }
  });

  it('omits unknown or invalid reading and reset timestamps', () => {
    const runs = snapshot(93);
    runs.codexPersonal!.asOf = 'invalid';
    runs.codexPersonal!.resetsAt = 'invalid';
    expect(supply(runs)[0]?.detail).toBe('3 jobs queued on codex-personal');
    runs.codexPersonal!.asOf = null;
    runs.lanes = [];
    expect(supply(runs)[0]?.detail).toBe('');
  });

  it('does not invent a queue count when the personal lane is missing', () => {
    const runs = snapshot(100);
    runs.lanes = [];
    expect(supply(runs)[0]).toMatchObject({ severity: 'attention', detail: 'Queue size is unknown' });
  });
});
