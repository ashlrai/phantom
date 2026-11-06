import { describe, expect, it } from 'vitest';
import { outcomeLabel, readCase, readOutcomes, stageLabel } from './fleet-outcomes-model.js';

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

describe('readOutcomes', () => {
  it('returns null for anything but a v1 read', () => {
    expect(readOutcomes(null)).toBeNull();
    expect(readOutcomes('x')).toBeNull();
    expect(readOutcomes({ v: 2 })).toBeNull();
    expect(readOutcomes({ state: 'current', feedback: feedback() })).toBeNull();
  });

  it('keeps the fixed outcome order and drops rows where both counts are zero', () => {
    const view = readOutcomes(read())!;
    expect(view.mix.map(row => row.outcome)).toEqual(['producer-succeeded', 'failed', 'refused']);
    expect(view.mix[0]).toMatchObject({ label: 'Produced', observed: 4, total: 5 });
    // observed > 0 keeps a row even when the exact total is a measured zero.
    expect(view.mix[2]).toMatchObject({ outcome: 'refused', observed: 1, total: 0 });
  });

  it('leaves the exact total null when counts are absent and still reports observed', () => {
    const view = readOutcomes(read({ feedback: feedback({ counts: null }) }))!;
    expect(view.mix.map(row => [row.outcome, row.total ?? 'null', row.observed]))
      .toEqual([['producer-succeeded', 'null', 4], ['failed', 'null', 2], ['refused', 'null', 1]]);
  });

  it('flags degraded, incomplete and skipped-attempt coverage in notes', () => {
    const view = readOutcomes(read({
      feedback: feedback({ sourceState: 'degraded', complete: false,
        coverage: { legacyRows: 0, invalidAttempts: 2, conflictingAttempts: 1, duplicateRows: 0, invalidTimestamps: 0, proposalSource: 'healthy' } }),
    }))!;
    expect(view.notes).toEqual([
      'Outcome data may be incomplete.',
      'The window is still being read.',
      '2 invalid and 1 conflicting attempts were skipped.',
    ]);
  });

  it('adds no notes for a healthy complete read', () => {
    expect(readOutcomes(read())!.notes).toEqual([]);
  });

  it('reports a null feedback object without a sourceState', () => {
    const view = readOutcomes({ v: 1, state: 'unavailable', refreshedAt: null, feedback: null })!;
    expect(view.sourceState).toBeNull();
    expect(view.state).toBe('unavailable');
    expect(view.mix).toEqual([]);
    expect(view.cases).toEqual([]);
  });

  it('sorts cases newest first and caps the list at 100', () => {
    const cases = [
      { caseId: caseId(1), endedAt: '2026-10-31T01:00:00Z', outcome: 'failed', failureKind: 'engine', proposalRecorded: false },
      { caseId: caseId(2), endedAt: '2026-10-31T03:00:00Z', outcome: 'producer-succeeded', failureKind: null, proposalRecorded: true },
      { caseId: caseId(3), endedAt: '2026-10-31T02:00:00Z', outcome: 'unknown-string', failureKind: null, proposalRecorded: false },
    ];
    const view = readOutcomes(read({ feedback: feedback({ cases }) }))!;
    expect(view.cases.map(item => item.caseId)).toEqual([caseId(2), caseId(3), caseId(1)]);
    expect(view.cases[1]).toMatchObject({ outcome: 'unknown', label: 'Unknown' });

    const many = Array.from({ length: 105 }, (_, i) =>
      ({ caseId: caseId(i), endedAt: new Date(Date.UTC(2026, 9, 31, 0, i)).toISOString(), outcome: 'failed', failureKind: null, proposalRecorded: false }));
    const capped = readOutcomes(read({ feedback: feedback({ cases: many }) }))!;
    expect(capped.cases).toHaveLength(100);
    expect(capped.cases[0]!.caseId).toBe(caseId(104));
    expect(capped.cases[99]!.caseId).toBe(caseId(5));
  });
});

describe('readCase', () => {
  const detail = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1, caseId: caseId(9), outcome: 'producer-succeeded', endedAt: '2026-10-31T03:00:00Z',
    coverage: { dispatch: 'healthy', proposals: 'healthy', ledger: 'healthy', invalidRecords: 0, conflictingRecords: 0 },
    timeline: [
      { stage: 'produced', at: '2026-10-31T01:00:00Z', result: 'recorded', basis: 'dispatch-final' },
      { stage: 'pr-opened', at: '2026-10-31T02:00:00Z', result: 'recorded', basis: 'authority-ledger', href: 'https://github.com/ashlrai/phantom/pull/42' },
      { stage: 'post-merge', at: '2026-10-31T03:00:00Z', result: 'green', basis: 'authenticated-host', ci: 'green', suite: 'pass', href: 'https://evil.example.com/x' },
      { stage: 'merged', at: null, result: 'host-merged', basis: 'authenticated-host', href: 'http://github.com/x' },
      { stage: 'merged', at: null, result: 'host-merged', basis: 'authenticated-host', href: 'not a url' },
    ],
    shipping: 'not-recorded', digest: 'h:ab', ...overrides,
  });

  it('returns null for anything but a v1 read', () => {
    expect(readCase(null)).toBeNull();
    expect(readCase({ v: 2 })).toBeNull();
  });

  it('keeps github.com https hrefs and drops every other link', () => {
    const view = readCase({ v: 1, state: 'current', refreshedAt: '2026-10-31T03:01:00Z', detail: detail() })!;
    expect(view.caseId).toBe(caseId(9));
    expect(view.label).toBe('Produced');
    expect(view.steps.map(step => step.href)).toEqual([null, 'https://github.com/ashlrai/phantom/pull/42', null, null, null]);
    expect(view.steps[2]).toMatchObject({ stageLabel: 'Post-merge CI', ci: 'green', suite: 'pass' });
    expect(view.steps[0]!.at).toBe('2026-10-31T01:00:00Z');
  });

  it('reports a missing detail object as an empty case', () => {
    expect(readCase({ v: 1, state: 'unavailable', refreshedAt: null, detail: null }))
      .toEqual({ state: 'unavailable', caseId: null, outcome: null, label: null, endedAt: null, steps: [] });
  });
});

describe('labels', () => {
  it('renders outcome and stage labels', () => {
    expect(outcomeLabel('producer-succeeded')).toBe('Produced');
    expect(outcomeLabel('empty-diff')).toBe('Empty diff');
    expect(outcomeLabel('cancelled')).toBe('Cancelled');
    expect(outcomeLabel('unknown')).toBe('Unknown');
    expect(stageLabel('pr-opened')).toBe('PR opened');
    expect(stageLabel('post-merge')).toBe('Post-merge CI');
    expect(stageLabel('merged')).toBe('Merged');
    expect(stageLabel('reverted')).toBe('Reverted');
  });
});
