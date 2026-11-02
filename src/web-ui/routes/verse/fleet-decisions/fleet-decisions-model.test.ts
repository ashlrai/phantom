import { expect, it } from 'vitest';
import { decisionRows, decisionSummary, holdRows, stallNote } from './fleet-decisions-model.js';
import { fixture } from './fixtures.js';

it('sorts, filters and projects router decisions', () => {
  const fleet = fixture();
  expect(decisionRows(fleet, 'all').map(d => d.title)).toEqual(['Second', 'Third', 'First']);
  expect(decisionRows(fleet, 'skipped')).toMatchObject([{ target: '—', reason: 'No seat', candidates: 2 }]);
  expect(decisionRows(fleet, 'launched')).toHaveLength(2);
  expect(decisionSummary(fleet)).toEqual({ launched: 2, skipped: 1, lastLaunchAt: '2026-10-31T14:00:00Z', lastSkipReason: 'No seat' });
  expect(stallNote(decisionSummary(fleet), fleet.tickAt, 0)).toBeNull();
  fleet.decisions = fleet.decisions.filter(d => !d.dispatched);
  expect(stallNote(decisionSummary(fleet), null, 0)).toBe('No launches in the journal window; last skip: No seat');
  fleet.decisions = [];
  expect(stallNote(decisionSummary(fleet), null, 0)).toBeNull();
});

it('sorts holds by lift time with missing and invalid times last', () => {
  const fleet = fixture(), base = fleet.held[0];
  fleet.held = [{ ...base, title: 'missing', nextEligibleAt: null }, base, { ...base, title: 'earlier', nextEligibleAt: '2027-01-01T00:00:00Z' }, { ...base, title: 'invalid', nextEligibleAt: 'bad' }];
  expect(holdRows(fleet).map(h => h.title)).toEqual(['earlier', 'Held task', 'missing', 'invalid']);
});
