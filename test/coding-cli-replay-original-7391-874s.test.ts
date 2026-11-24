import { expect, it } from 'vitest';
import { offlineCandidateKey, scoreOfflinePolicy, type OfflineReplayPolicy, type OfflineReplayRow } from '../src/core/providers/coding-cli/offline-policy-replay.js';
import { compareOfflineReplay } from '../src/core/providers/coding-cli/replay-comparison.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

it('scores shared frozen rows with the supplied floor and reports strict comparisons', () => {
  const a = { poolId: 'orchid', consumer: null };
  const b = { poolId: 'maple', consumer: 'reader' };
  const rows: readonly OfflineReplayRow[] = deepFreeze([
    { rowId: 'one', loggedPoolId: a.poolId, loggedConsumer: a.consumer, propensity: 0.125, reward: 1, eligible: [a, b] },
    { rowId: 'two', loggedPoolId: b.poolId, loggedConsumer: b.consumer, propensity: 0.5, reward: 0.5, eligible: [a, b] },
    { rowId: 'three', loggedPoolId: a.poolId, loggedConsumer: a.consumer, propensity: 1, reward: 0.75, eligible: [a, b] },
  ]);
  const keyA = offlineCandidateKey(a.poolId, a.consumer);
  const keyB = offlineCandidateKey(b.poolId, b.consumer);
  const incumbent: OfflineReplayPolicy = deepFreeze({ id: 'incumbent', predictions: {
    one: { [keyA]: 0.5, [keyB]: 0.25 }, two: { [keyA]: 0.75, [keyB]: 0.25 }, three: { [keyA]: 0.25, [keyB]: 0.5 },
  } });
  const candidate: OfflineReplayPolicy = deepFreeze({ id: 'candidate', predictions: {
    one: { [keyA]: 0.25, [keyB]: 0.5 }, two: { [keyA]: 0.25, [keyB]: 0.75 }, three: { [keyA]: 0.5, [keyB]: 0.25 },
  } });
  const before = structuredClone({ rows, incumbent, candidate });
  // Floor 1/4: incumbent contributions 1/2 + 4(1 - 1/2), 3/4, 1/2 = 5/4 mean.
  // Candidate contributions 1/2, 3/4 + 2(1/2 - 3/4), 1/2 + (3/4 - 1/2) = 1/2 mean.
  const floor = 0.25;
  expect(scoreOfflinePolicy({ rows, policy: incumbent, propensityFloor: floor })).toMatchObject({ doublyRobust: 1.25, clippedRows: 1 });
  expect(scoreOfflinePolicy({ rows, policy: candidate, propensityFloor: floor })).toMatchObject({ doublyRobust: 0.5, clippedRows: 1 });
  const expected = { incumbentScore: 1.25, candidateScore: 0.5, rowCount: 3, sufficientRows: true, candidateMinusIncumbent: -0.75, comparison: 'incumbent-higher' };
  expect(compareOfflineReplay(rows, incumbent, candidate, 3, floor)).toEqual(expected);
  expect(compareOfflineReplay(rows, candidate, incumbent, 3, floor)).toEqual({ ...expected, incumbentScore: 0.5, candidateScore: 1.25, candidateMinusIncumbent: 0.75, comparison: 'candidate-higher' });
  expect(compareOfflineReplay(rows, incumbent, incumbent, 3, floor)).toEqual({ ...expected, candidateScore: 1.25, candidateMinusIncumbent: 0, comparison: 'equal' });
  expect(compareOfflineReplay(rows, incumbent, candidate, 4, floor)).toEqual({ ...expected, sufficientRows: false, comparison: 'insufficient-data' });
  expect(compareOfflineReplay(rows, incumbent, candidate, 3, floor)).toEqual(expected);
  expect({ rows, incumbent, candidate }).toEqual(before);
});
