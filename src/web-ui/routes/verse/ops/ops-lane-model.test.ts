/**
 * ops-lane-model.test.ts : the lane console's pure derivations — chips,
 * credit tones, countdown phrases, the bar's spoken label, source notes.
 */
import { describe, expect, it } from 'vitest';
import type { FleetLaneCreditView, FleetLaneSnapshot, FleetLaneView } from '../../../data/api-types.js';
import {
  creditBarLabel, creditLine, creditTone, durationText, exhaustionText,
  laneChipText, resetText, sourceNotes,
} from './ops-lane-model.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');

const credit = (over: Partial<FleetLaneCreditView> = {}): FleetLaneCreditView => ({
  state: 'observed', label: '64% weekly', remainingPct: 64, remainingCredits: null, creditsUnit: null,
  resetAt: null, burnPerHour: null, projectedExhaustionAt: null, observedAt: null, source: 'budget-ledger', ...over,
});

const lane = (over: Partial<FleetLaneView> = {}): FleetLaneView =>
  ({ lane: 'codex-personal', queueDepth: 3, liveJobs: 2, mergesPerHour: 1.25, credit: credit(), ...over });

const snapshot = (): FleetLaneSnapshot => ({
  schema: 'fleet.lanes.v1', generatedAt: '2026-10-31T11:59:48Z', mergeWindowMinutes: 60,
  sources: {
    queue: { state: 'healthy', file: 'ready.tsv', rows: 4, dropped: 0 }, queueState: { state: 'healthy', file: 'queue.v1.json', jobs: 3 },
    ledger: { state: 'healthy', file: 'jobs.jsonl', events: 7, dropped: 0 }, usage: { state: 'healthy', files: ['usage-readings.log'], pools: 2, dropped: 0 },
    budgets: { state: 'healthy' },
  },
  lanes: [],
});

describe('ops-lane-model', () => {
  it('formats durations as spaced units', () => {
    expect(durationText(12_000)).toBe('12 s');
    expect(durationText(90_000)).toBe('2 min');
    expect(durationText(2 * 3_600_000)).toBe('2 h');
    expect(durationText(3 * 86_400_000)).toBe('3 d');
  });

  it('builds the three chips, good tone only while live jobs run, — for nulls', () => {
    const chips = laneChipText(lane());
    expect(chips.map((c) => c.text)).toEqual(['live 2', 'queued 3', 'merges/h 1.3']);
    expect(chips[0]!.tone).toBe('good');
    expect(laneChipText(lane({ liveJobs: 0 }))[0]!.tone).toBeUndefined();
    expect(laneChipText(lane({ liveJobs: null, queueDepth: null, mergesPerHour: null })).map((c) => c.text))
      .toEqual(['live —', 'queued —', 'merges/h —']);
  });

  it('tones the credit bar: bad <10, warn <25, good above, null for no reading', () => {
    expect(creditTone(null)).toBeNull();
    expect(creditTone(9)).toBe('bad');
    expect(creditTone(10)).toBe('warn');
    expect(creditTone(25)).toBe('good');
  });

  it('reads exhaustion and reset countdowns in both directions', () => {
    expect(exhaustionText('2026-10-31T14:00:00Z', NOW)).toBe('runs out in 2 h');
    expect(exhaustionText('2026-10-31T11:55:00Z', NOW)).toBe('ran out 5 min ago');
    expect(exhaustionText(null, NOW)).toBeNull();
    expect(exhaustionText('junk', NOW)).toBeNull();
    expect(resetText(credit(), NOW)).toBeNull();
    expect(resetText(credit({ state: 'reset-pending', resetAt: '2026-10-31T14:00:00Z' }), NOW)).toBe('resets in 2 h');
    expect(resetText(credit({ state: 'reset-pending', resetAt: '2026-10-31T11:00:00Z' }), NOW)).toBe('resets now');
    expect(resetText(credit({ state: 'reset-pending', resetAt: null }), NOW)).toBe('reset pending');
    expect(creditLine(lane(), NOW)).toBe('64% weekly');
    expect(creditLine(lane({ credit: credit({ state: 'reset-pending', resetAt: '2026-10-31T14:00:00Z' }) }), NOW)).toBe('resets in 2 h');
  });

  it('labels the bar with the window the percent came from, none without a reading', () => {
    expect(creditBarLabel(lane())).toBe('codex-personal: 64% of weekly window left');
    expect(creditBarLabel(lane({ credit: credit({ source: 'usage-journal' }) }))).toBe('codex-personal: 64% of window left');
    expect(creditBarLabel(lane({ credit: credit({ remainingPct: null }) }))).toBeNull();
    expect(creditBarLabel(lane({ credit: credit({ state: 'unknown', remainingPct: 40, source: null }) }))).toBeNull();
  });

  it('lists each unhealthy source with its basename, nothing when all healthy', () => {
    expect(sourceNotes(snapshot())).toEqual([]);
    const snap = snapshot();
    snap.sources.queue = { state: 'missing', file: 'ready.tsv', rows: 0, dropped: 0 };
    snap.sources.ledger = { state: 'degraded', file: 'jobs.jsonl', events: 3, dropped: 2 };
    snap.sources.usage = { state: 'missing', files: [], pools: 0, dropped: 0 };
    snap.sources.budgets = { state: 'unavailable' };
    expect(sourceNotes(snap)).toEqual([
      'queue: missing (ready.tsv)', 'ledger: degraded (jobs.jsonl)', 'usage: missing', 'budgets: unavailable',
    ]);
  });
});
