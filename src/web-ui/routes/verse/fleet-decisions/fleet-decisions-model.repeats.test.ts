import { expect, it } from 'vitest';
import { decisionSummary, repeatedSkips, stallNote } from './fleet-decisions-model.js';
import { fixture } from './fixtures.js';

it('counts each current skip streak in time order and applies the threshold', () => {
  const fleet = fixture(), base = fleet.decisions[2];
  fleet.decisions = [
    ...[4, 1, 3, 2].map(hour => ({ ...base, itemId: 'long', title: 'Long', at: `2026-10-31T0${hour}:00:00Z`, skipReason: hour === 4 ? 'Newest reason' : 'Old reason' })),
    ...[1, 2].map(hour => ({ ...base, itemId: 'short', title: 'Short', at: `2026-10-31T0${hour}:00:00Z` })),
  ];
  expect(repeatedSkips(fleet)).toEqual([{ itemId: 'long', title: 'Long', runs: 4, since: '2026-10-31T01:00:00Z', reason: 'Newest reason' }]);
  expect(repeatedSkips(fleet, 2).map(row => [row.itemId, row.runs])).toEqual([['long', 4], ['short', 2]]);
  expect(stallNote(decisionSummary(fleet), fleet.tickAt, 0, repeatedSkips(fleet).length)).toBe('No launches in the journal window; last skip: Newest reason · 1 bets skipped 3+ ticks in a row');
});

it('ends a streak at a launch of the same item and sorts ties by title', () => {
  const fleet = fixture(), base = fleet.decisions[2];
  fleet.decisions = [
    ...[1, 2, 3, 4, 5, 6].map(hour => ({ ...base, itemId: 'reset', title: 'Zulu', at: `2026-10-31T0${hour}:00:00Z`, dispatched: hour === 3, skipReason: null, why: hour === 6 ? 'Fallback reason' : null })),
    ...[1, 2, 3].map(hour => ({ ...base, itemId: 'other', title: 'Alpha', at: `2026-10-31T0${hour}:00:00Z` })),
  ];
  expect(repeatedSkips(fleet)).toEqual([
    { itemId: 'other', title: 'Alpha', runs: 3, since: '2026-10-31T01:00:00Z', reason: 'No seat' },
    { itemId: 'reset', title: 'Zulu', runs: 3, since: '2026-10-31T04:00:00Z', reason: 'Fallback reason' },
  ]);
  fleet.decisions.push({ ...base, itemId: 'reset', at: '2026-10-31T07:00:00Z', dispatched: true });
  expect(repeatedSkips(fleet).map(row => row.itemId)).toEqual(['other']);
});
