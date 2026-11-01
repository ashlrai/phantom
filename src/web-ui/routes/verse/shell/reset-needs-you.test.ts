import { describe, expect, it } from 'vitest';
import { deriveResetNeedsYou, mergeNeedsYou } from './reset-needs-you.js';
import { narrowUsageResets, type UsageResetRow } from './usage-resets-query.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';

const row = (lane: string, state: UsageResetRow['state'], heldBy: UsageResetRow['heldBy'], releasable: boolean): UsageResetRow => ({
  lane, state, heldBy, releasable, held: true, heldReason: 'fake reason', heldUntil: null, holdSince: null,
  usedPct: 10, readingAsOf: null, resetAt: null, tell: `${lane} can be checked.`,
});
const wire = (rows: UsageResetRow[]) => ({ v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', rows });

describe('usage reset rows', () => {
  it('validates the whole response and rejects malformed fields', () => {
    const valid = wire([row('lane-a', 'reset-detected', 'autobackoff', true)]);
    expect(narrowUsageResets(valid)).toEqual(valid);
    expect(narrowUsageResets({ ...valid, v: 2 })).toBeNull();
    expect(narrowUsageResets({ ...valid, sourceState: 'unknown' })).toBeNull();
    for (const bad of [{ held: 'yes' }, { usedPct: NaN }, { state: 'unknown' }, { heldBy: 'other' }, { tell: null }, { resetAt: 5 }]) {
      expect(narrowUsageResets({ ...valid, rows: [{ ...valid.rows[0], ...bad }] })).toBeNull();
    }
    expect(narrowUsageResets({ ...valid, rows: [null] })).toBeNull();
  });
  it('only offers releasable autobackoff resets and expired holds, in order', () => {
    const valid = narrowUsageResets(wire([
      row('lane-a', 'reset-detected', 'autobackoff', true), row('lane-b', 'hold-expired', 'autobackoff', true),
      row('lane-c', 'manual-hold', 'manual', true), row('lane-d', 'consistent', 'autobackoff', false),
      row('lane-e', 'consistent', 'autobackoff', true),
    ]));
    expect(deriveResetNeedsYou(valid, 0)).toMatchObject([
      { id: 'lane-reset:lane-a', severity: 'urgent', title: 'lane-a reset; its hold is still on', detail: 'lane-a can be checked.', target: 'fleet', open: { kind: 'pane', paneId: 'fleet-lanes' } },
      { id: 'lane-reset:lane-b', title: 'lane-b hold expired; still marked held' },
    ]);
  });
  it('replaces older entries for the same lane and preserves unrelated items', () => {
    const item = (id: string): FleetNeedsYouItem => ({ id, severity: 'attention', title: id, detail: '', nextStep: '', target: 'fleet' });
    const reset = deriveResetNeedsYou(narrowUsageResets(wire([row('codex-personal', 'reset-detected', 'autobackoff', true)])), 0);
    expect(mergeNeedsYou({ answered: true, items: [item('supply-personal-reset'), item('lane-held:codex-personal'), item('other')] }, reset).items.map(i => i.id))
      .toEqual(['other', 'lane-reset:codex-personal']);
  });
});
