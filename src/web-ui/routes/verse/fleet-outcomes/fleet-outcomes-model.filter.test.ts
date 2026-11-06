import { describe, expect, it } from 'vitest';
import { filterCases, outcomeChips, readOutcomes } from './fleet-outcomes-model.js';

const ZERO = { 'producer-succeeded': 0, failed: 0, cancelled: 0, refused: 0, 'empty-diff': 0, disabled: 0, unknown: 0 };
const caseId = (n: number) => `h:${String(n).padStart(16, '0')}:${String(n).padStart(16, '0')}:${String(n).padStart(16, '0')}:${String(n).padStart(16, '0')}`;

const feedback = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, sourceState: 'healthy', complete: true,
  window: { since: '2026-10-30T00:00:00Z', through: '2026-10-31T00:00:00Z' },
  observedThrough: '2026-10-31T00:00:00Z',
  counts: { ...ZERO, 'producer-succeeded': 5, failed: 2 },
  observedCounts: { ...ZERO, 'producer-succeeded': 4, failed: 2, refused: 1 },
  cases: [], digest: 'h:ab',
  coverage: { legacyRows: 0, invalidAttempts: 0, conflictingAttempts: 0, duplicateRows: 0, invalidTimestamps: 0, proposalSource: 'healthy' },
  ...overrides,
});
const read = (overrides: Record<string, unknown> = {}) =>
  ({ v: 1, state: 'current', refreshedAt: '2026-10-31T00:01:00Z', feedback: feedback(), ...overrides });

const cases = [
  { caseId: caseId(1), endedAt: '2026-10-31T01:00:00Z', outcome: 'failed', failureKind: 'engine', proposalRecorded: false },
  { caseId: caseId(2), endedAt: '2026-10-31T03:00:00Z', outcome: 'producer-succeeded', failureKind: null, proposalRecorded: true },
  { caseId: caseId(3), endedAt: '2026-10-31T02:00:00Z', outcome: 'failed', failureKind: 'sandbox', proposalRecorded: false },
];

describe('filterCases', () => {
  it('returns every row for all, and only matching rows in read order otherwise', () => {
    const view = readOutcomes(read({ feedback: feedback({ cases }) }))!;
    // readOutcomes sorts newest first: 2, 3, 1.
    expect(filterCases(view, 'all')).toBe(view.cases);
    expect(filterCases(view, 'failed').map(item => item.caseId)).toEqual([caseId(3), caseId(1)]);
    expect(filterCases(view, 'producer-succeeded').map(item => item.caseId)).toEqual([caseId(2)]);
    expect(filterCases(view, 'empty-diff')).toEqual([]);
  });
});

describe('outcomeChips', () => {
  it('puts All first with the case count, then each counted outcome in mix order', () => {
    const view = readOutcomes(read({ feedback: feedback({ cases }) }))!;
    expect(outcomeChips(view)).toEqual([
      { outcome: 'all', label: 'All', count: 3 },
      { outcome: 'producer-succeeded', label: 'Produced', count: 5 },
      { outcome: 'failed', label: 'Failed', count: 2 },
    ]);
  });

  it('omits an outcome whose best count is a measured zero', () => {
    // refused is observed once, but the completed read measured an exact zero;
    // the chip count is total ?? observed, so the chip is dropped.
    const view = readOutcomes(read())!;
    expect(outcomeChips(view).map(chip => chip.outcome)).toEqual(['all', 'producer-succeeded', 'failed']);
  });

  it('falls back to observed counts while the detailed read is incomplete', () => {
    const view = readOutcomes(read({ feedback: feedback({ counts: null }) }))!;
    expect(outcomeChips(view)).toEqual([
      { outcome: 'all', label: 'All', count: 0 },
      { outcome: 'producer-succeeded', label: 'Produced', count: 4 },
      { outcome: 'failed', label: 'Failed', count: 2 },
      { outcome: 'refused', label: 'Refused', count: 1 },
    ]);
  });
});
