import { describe, expect, it } from 'vitest';
import type { FleetLaneSnapshot, FleetLaneView } from '../src/core/fleet/lane-console.js';
import { asLaneSupplyReport, buildLaneSupply, formatLaneSupply, readPlannerFacts } from '../src/core/fleet/lane-supply.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const credit = (leftPct: number | null, resetAt: string | null = '2026-11-22T12:00:00Z'): FleetLaneView['credit'] => ({
  state: leftPct === null ? 'unknown' : 'observed', label: '', remainingPct: leftPct, remainingCredits: null, creditsUnit: null,
  resetAt, burnPerHour: null, projectedExhaustionAt: null, observedAt: null, source: null,
});
const lane = (name: string, over: Partial<FleetLaneView> = {}): FleetLaneView => ({
  lane: name, queueDepth: 0, liveJobs: 0, mergesPerHour: null, startsInWindow: null, credit: credit(50),
  slotTarget: 4, hold: null, health: { verdict: 'ok', reason: '' } as FleetLaneView['health'], ...over,
});
const snapshot = (lanes: FleetLaneView[], openRows: number | null = null): FleetLaneSnapshot => ({
  lanes,
  starved: { lanes: {}, waiting_elsewhere: 0, open_rows: openRows },
} as FleetLaneSnapshot);

describe('lane supply verdicts', () => {
  it('raises the alarm for a lane with free slots, nothing queued and usage left', () => {
    const report = buildLaneSupply(snapshot([lane('claude', { liveJobs: 2, slotTarget: 8, credit: credit(68) })]), null, NOW);
    expect(report.lanes[0]).toMatchObject({ verdict: 'idle-with-usage-left', freeSlots: 6, usedPct: 32, leftPct: 68, hoursToReset: 48 });
    expect(report.alarm).toBe('claude idle: 6 free slots, 68% left');
    expect(report.idle).toEqual(['claude']);
  });

  it('calls a lane busy when work is queued or all slots run', () => {
    const report = buildLaneSupply(snapshot([lane('a', { liveJobs: 1, queueDepth: 3 }), lane('b', { liveJobs: 4 })]), null, NOW);
    expect(report.lanes.map(l => l.verdict)).toEqual(['busy', 'busy']);
    expect(report.alarm).toBeNull();
  });

  it('says out of usage until the reset for a 100% pool, even with free slots', () => {
    const [row] = buildLaneSupply(snapshot([lane('codex', { credit: credit(0, '2026-11-21T06:30:00Z') })]), null, NOW).lanes;
    expect(row).toMatchObject({ verdict: 'out-of-usage', usedPct: 100, hoursToReset: 18.5 });
    expect(row!.text).toBe('codex out of usage until 2026-11-21 06:30 UTC');
  });

  it('reports a held lane as held and never as idle', () => {
    const [row] = buildLaneSupply(snapshot([lane('devin', { hold: { held: true, reason: 'weekly pool', until: null, by: 'manual', since: null } })]), null, NOW).lanes;
    expect(row).toMatchObject({ verdict: 'held', freeSlots: 0, text: 'devin held: weekly pool' });
  });

  it('does not claim usage is left when the pool reading is missing', () => {
    const report = buildLaneSupply(snapshot([lane('grok', { credit: credit(null, null) })]), null, NOW);
    expect(report.lanes[0]).toMatchObject({ verdict: 'idle-usage-unknown', usedPct: null, hoursToReset: null });
    expect(report.alarm).toBeNull();
  });

  it('keeps a lane with no target (null ceiling) or unknown running count out of the alarm', () => {
    const report = buildLaneSupply(snapshot([lane('x', { slotTarget: null }), lane('y', { liveJobs: null })]), null, NOW);
    expect(report.lanes.map(l => l.verdict)).toEqual(['unknown', 'unknown']);
    expect(report.lanes[0]!.freeSlots).toBeNull();
  });

  it('puts the lane with the most free slots first in the alarm', () => {
    const report = buildLaneSupply(snapshot([lane('a', { slotTarget: 2 }), lane('b', { slotTarget: 5 })]), null, NOW);
    expect(report.idle).toEqual(['b', 'a']);
  });

  it('reads a free lane with usage left as open supply, not idle, while lane-open rows wait', () => {
    const report = buildLaneSupply(snapshot([lane('claude', { liveJobs: 2, slotTarget: 8, credit: credit(68) })], 12), null, NOW);
    expect(report.lanes[0]).toMatchObject({ verdict: 'open-supply', freeSlots: 6, leftPct: 68 });
    expect(report.lanes[0]!.text).toBe('claude open supply: 6 free slots, 68% left, 12 open rows wait');
    expect(report.idle).toEqual([]);
    expect(report.alarm).toBeNull();
  });

  it('still alarms when the lane-open count is zero or unknown', () => {
    for (const openRows of [0, null]) {
      const report = buildLaneSupply(snapshot([lane('claude', { liveJobs: 2, slotTarget: 8, credit: credit(68) })], openRows), null, NOW);
      expect(report.lanes[0]!.verdict).toBe('idle-with-usage-left');
      expect(report.idle).toEqual(['claude']);
    }
  });

  it('keeps out-of-usage and held verdicts ahead of open supply', () => {
    const report = buildLaneSupply(snapshot([
      lane('codex', { credit: credit(0, '2026-11-21T06:30:00Z') }),
      lane('devin', { hold: { held: true, reason: 'weekly pool', until: null, by: 'manual', since: null } }),
    ], 5), null, NOW);
    expect(report.lanes.map(l => l.verdict)).toEqual(['out-of-usage', 'held']);
    expect(report.alarm).toBeNull();
  });
});

describe('planner and autofill facts', () => {
  const record = (over: Record<string, unknown> = {}) => JSON.stringify({
    v: 1, at: '2026-11-20T11:30:00Z', mode: 'apply', state: 'ran',
    steps: [{ step: 'planner-tick', state: 'ok', exitCode: 0, report: { autofill: { runs: [{ applied: 3 }], reason: 'lane starved' } } }], ...over,
  });

  it('reads the last pass age and the autofill decision', () => {
    expect(readPlannerFacts(record(), NOW)).toEqual({
      planner: { state: 'known', lastPassAt: '2026-11-20T11:30:00.000Z', ageSeconds: 1800 },
      autofill: { state: 'ran', items: 3, note: 'lane starved' },
    });
  });

  it('is unknown, never zero, for a missing, broken or planner-less record', () => {
    for (const text of [null, 'not json', record({ steps: [] }), record({ state: 'busy' })]) {
      expect(readPlannerFacts(text, NOW)).toEqual({ planner: { state: 'unknown', lastPassAt: null, ageSeconds: null }, autofill: { state: 'unknown', items: null, note: null } });
    }
  });
});

describe('format and guard', () => {
  it('prints one plain line per lane, the alarm and the planner facts', () => {
    const text = formatLaneSupply(buildLaneSupply(snapshot([lane('claude', { liveJobs: 2, slotTarget: 8, credit: credit(68) })]), null, NOW));
    expect(text).toContain('claude: 2/8 running, 0 queued, 32% used, resets in 48 h; IDLE WITH USAGE LEFT');
    expect(text).toContain('ALARM: claude idle: 6 free slots, 68% left');
    expect(text).toContain('Planner last pass: unknown');
  });

  it('words held and out-of-usage lanes plainly', () => {
    const text = formatLaneSupply(buildLaneSupply(snapshot([
      lane('devin', { hold: { held: true, reason: 'weekly pool', until: null, by: 'manual', since: null } }),
      lane('codex', { credit: credit(0, '2026-11-21T06:30:00Z') }),
    ]), null, NOW));
    expect(text).toContain('codex: 0/4 running, 0 queued, 100% used, resets in 18.5 h; out of usage until 2026-11-21 06:30 UTC');
    expect(text).toContain('devin: 0/4 running, 0 queued, 50% used, resets in 48 h; held weekly pool');
    expect(text).toContain('No lane is idle with usage left.');
  });

  it('prints the open-supply verdict plainly', () => {
    const text = formatLaneSupply(buildLaneSupply(snapshot([lane('claude', { liveJobs: 2, slotTarget: 8, credit: credit(68) })], 3), null, NOW));
    expect(text).toContain('claude: 2/8 running, 0 queued, 32% used, resets in 48 h; open supply');
    expect(text).toContain('No lane is idle with usage left.');
  });

  it('only accepts its own schema', () => {
    expect(asLaneSupplyReport(buildLaneSupply(snapshot([]), null, NOW))).not.toBeNull();
    expect(asLaneSupplyReport({ schema: 'other' })).toBeNull();
    expect(asLaneSupplyReport(null)).toBeNull();
  });
});
