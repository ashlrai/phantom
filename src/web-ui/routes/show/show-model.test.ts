import { describe, expect, it } from 'vitest';
import type { FleetLaneSnapshot, FleetLaneView } from '../../data/api-types.js';
import type { JournalEntry, JournalSource } from '../journal/journal-model.js';
import { buildAgentFeed, buildQuotaGauges, buildWins } from './show-model.js';

const entry = (id: string, source: JournalSource, statusLabel: string): JournalEntry => ({ id, ts: '2026-01-01T00:00:00Z', source, title: id, detail: '', statusLabel });

const lane = (name: string, credit: Partial<FleetLaneView['credit']>, held = false): FleetLaneView => ({
  lane: name, queueDepth: null, liveJobs: null, mergesPerHour: null, slotTarget: null,
  credit: { state: 'observed', label: name, remainingPct: null, remainingCredits: null, creditsUnit: null, resetAt: null, burnPerHour: null, projectedExhaustionAt: null, observedAt: null, source: null, ...credit },
  hold: held ? { held: true, reason: null, until: null, by: 'manual', since: null } : null,
});

describe('show-model', () => {
  const entries = [
    entry('a1', 'agent-action', 'started'), entry('m1', 'merge', 'merged'), entry('r1', 'run', 'done'),
    entry('a2', 'agent-action', 'verified'), entry('t1', 'daemon-tick', 'info'), entry('p1', 'proposal', 'pending'), entry('r2', 'run', 'failed'),
  ];
  it('agent feed keeps only agent actions and runs, honoring the limit', () => {
    expect(buildAgentFeed(entries).map(e => e.id)).toEqual(['a1', 'r1', 'a2', 'r2']);
    expect(buildAgentFeed(entries, 2).map(e => e.id)).toEqual(['a1', 'r1']);
  });
  it('wins are merges and concretely successful work only', () => {
    expect(buildWins(entries).map(e => e.id)).toEqual(['m1', 'r1', 'a2']);
  });
  it('gauges drop unknown lanes and never invent a percentage', () => {
    const snapshot = { lanes: [
      lane('a', { remainingPct: 140 }), lane('b', { state: 'unknown' }), lane('c', { state: 'reset-pending', label: 'capacity 3' }, true),
    ] } as FleetLaneSnapshot;
    expect(buildQuotaGauges(snapshot)).toEqual([
      { lane: 'a', pct: 100, label: 'a', resetAt: null, held: false },
      { lane: 'c', pct: null, label: 'capacity 3', resetAt: null, held: true },
    ]);
    expect(buildQuotaGauges(undefined)).toEqual([]);
  });
});
