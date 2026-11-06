import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { deriveFleetNeedsYou } from './fleet-needs-you.js';

const NOW = Date.parse('2026-10-31T16:21:00-04:00');
const AS_OF = '2026-10-31T16:20:00-04:00';
const REASON = 'autobackoff codex_usage_limit job=RQ-FAKE until=2026-10-31T20:02:15-04:00 src=outcome_unreadable';

function snapshot(over: Partial<FleetRuns> = {}): FleetRuns {
  return {
    v: 1, generatedAt: new Date(NOW).toISOString(),
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: new Date(NOW).toISOString(), paused: false, memFreePct: 50, diskFreeGb: 80,
    switches: [], claudeLane: null,
    lanes: [{ lane: 'codex-personal', running: 0, target: 2, queued: 14, held: true, heldReason: REASON, tokensLastHour: 0, merged24h: 0, mergeRate24h: 0 }],
    workers: [], leaders: [{ label: 'leader', ageSeconds: 30 }], orchestratorAgents: 1,
    publishesLastHour: [], mergesLastHour: { count: 1, items: [] }, events: [],
    codexPersonal: { usedPct: 0, resetsAt: null, asOf: AS_OF }, inbox: [], drop: null,
    ...over,
  };
}

function items(runs: FleetRuns) {
  return deriveFleetNeedsYou(runs, NOW).items;
}

describe('personal Codex reset in Needs you', () => {
  it('directs the Oct 31 stale hold to the lanes pane', () => {
    const result = items(snapshot());
    const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(AS_OF));
    expect(result.map((item) => item.id)).toEqual(['lane-held:codex-personal', 'supply-personal-reset']);
    expect(result[1]).toEqual({
      id: 'supply-personal-reset', open: { kind: 'pane', paneId: 'fleet-lanes' },
      severity: 'urgent', title: 'Personal Codex has reset; its lane is still held',
      detail: `Reads 0% as of ${time} · 14 jobs waiting`,
      nextStep: 'Release the hold in Fleet ▸ Lanes, or wait for it to expire', target: 'fleet',
    });
  });

  it('uses attention with no queued jobs and accepts the 25% boundary', () => {
    const runs = snapshot();
    runs.lanes[0]!.queued = 0;
    runs.codexPersonal!.usedPct = 25;
    expect(items(runs).find((item) => item.id === 'supply-personal-reset')).toMatchObject({
      severity: 'attention', detail: expect.stringContaining('25%'),
    });
  });

  it('still reports a 97% limit-held account as out', () => {
    const runs = snapshot();
    runs.codexPersonal!.usedPct = 97;
    expect(items(runs).map((item) => item.id)).toEqual(['lane-held:codex-personal', 'supply-personal-out']);
  });

  it('leaves a low reading without a usable past timestamp to the held-lane row', () => {
    for (const asOf of [null, 'invalid', '2026-10-31T16:22:00-04:00']) {
      const runs = snapshot();
      runs.codexPersonal!.asOf = asOf;
      expect(items(runs).map((item) => item.id)).toEqual(['lane-held:codex-personal']);
    }
  });

  it('does not interpret a manual hold or an unheld lane as a reset', () => {
    for (const held of [true, false]) {
      const runs = snapshot();
      runs.lanes[0]!.held = held;
      runs.lanes[0]!.heldReason = 'manual maintenance';
      expect(items(runs).filter((item) => item.id.startsWith('supply-personal-'))).toEqual([]);
    }
  });

  it('recognizes each limit-hold reason and leaves a 26% reading alone', () => {
    for (const reason of ['AUTOBACKOFF', 'usage', 'LIMIT', 'exhausted']) {
      const runs = snapshot();
      runs.lanes[0]!.heldReason = reason;
      expect(items(runs).map((item) => item.id)).toContain('supply-personal-reset');
      runs.codexPersonal!.usedPct = 26;
      expect(items(runs).map((item) => item.id)).toEqual(['lane-held:codex-personal']);
    }
  });

  it('keeps an unknown reading with a limit hold as out', () => {
    const runs = snapshot();
    runs.codexPersonal!.usedPct = null;
    expect(items(runs).map((item) => item.id)).toEqual(['lane-held:codex-personal', 'supply-personal-out']);
  });
});
