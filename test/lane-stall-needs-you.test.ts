import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../src/web-ui/routes/verse/ops/ops-runs-model.js';
import { deriveLaneStallNeedsYou, LANE_STALL_MINUTES } from '../src/web-ui/routes/verse/shell/lane-stall-needs-you.js';

const NOW = Date.parse('2026-11-04T00:00:00Z');
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function runs(lane: Partial<FleetRuns['lanes'][number]> = {}, claimedAt?: string): FleetRuns {
  return {
    v: 1, generatedAt: new Date(NOW).toISOString(),
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: null, paused: false, memFreePct: 50, diskFreeGb: 80, switches: [], claudeLane: null,
    lanes: [{ lane: 'fake-lane', running: 0, target: 4, queued: 13, held: false, heldReason: null, tokensLastHour: 0, merged24h: 0, mergeRate24h: 0, ...lane }],
    workers: [], ...(claimedAt ? { claimed: [{ job: 'fake-job', lane: 'fake-lane', tier: 'fake', at: claimedAt }] } : {}),
    leaders: [], orchestratorAgents: 0, publishesLastHour: [], mergesLastHour: { count: 0, items: [] },
    events: [], codexPersonal: null, inbox: [], drop: null,
  };
}

describe('deriveLaneStallNeedsYou', () => {
  it('stalled lane gives a row with the counts and opens Lanes', () => {
    expect(deriveLaneStallNeedsYou(runs({}, minAgo(40)), NOW)).toEqual([expect.objectContaining({
      id: 'lane-stall:fake-lane', open: { kind: 'pane', paneId: 'fleet-lanes' }, severity: 'urgent',
      title: 'fake-lane stalled: 13 queued, 0 of 4 running, not held, no launch for 40 min',
    })]);
  });

  it.each([
    ['held', { held: true }],
    ['full', { running: 4 }],
    ['empty queue', { queued: 0 }],
    ['target 0', { target: 0 }],
    ['usage limit', { heldReason: 'usage_limit' }],
  ])('gives no row for a %s lane', (_name, change) => {
    expect(deriveLaneStallNeedsYou(runs(change, minAgo(40)), NOW)).toEqual([]);
  });

  it('flips at the 15 minute boundary', () => {
    expect(LANE_STALL_MINUTES).toBe(15);
    expect(deriveLaneStallNeedsYou(runs({}, minAgo(14)), NOW)).toEqual([]);
    expect(deriveLaneStallNeedsYou(runs({}, minAgo(15)), NOW)[0]?.title).toContain('no launch for 15 min');
  });

  it('shows the row without a minute count when no launch time is known', () => {
    expect(deriveLaneStallNeedsYou(runs(), NOW)[0]?.title)
      .toBe('fake-lane stalled: 13 queued, 0 of 4 running, not held, no launch observed');
  });

  it('uses the youngest running worker as the last launch', () => {
    const r = runs({ running: 1 });
    r.workers = [{ job: 'a', repo: 'r', lane: 'fake-lane', tier: 't', ageSeconds: 3_000 }, { job: 'b', repo: 'r', lane: 'fake-lane', tier: 't', ageSeconds: 120 }];
    expect(deriveLaneStallNeedsYou(r, NOW)).toEqual([]);
  });

  it('returns nothing without a reading', () => {
    expect(deriveLaneStallNeedsYou(null, NOW)).toEqual([]);
  });
});
