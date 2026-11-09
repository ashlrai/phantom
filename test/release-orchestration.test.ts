import { describe, expect, test } from 'vitest';
import { advanceRelease, type ReleaseCandidate, type ReleaseState } from '../src/core/release/orchestration.js';

const candidate: ReleaseCandidate = { repository: 'ashlrai/phantom', sourceSha: 'a'.repeat(40), version: '3.30.24', workflow: '.github/workflows/publish-canonical-npm.yml' };
const gates = { type: 'gates', candidate, checks: 'pass', grant: 'allowed', workflow: 'sanctioned', ownerReserved: 'clear' } as const;
const detected = (): ReleaseState => advanceRelease({ phase: 'detect' }, { type: 'detected', candidate });
const dispatching = (): ReleaseState => advanceRelease(advanceRelease(detected(), gates), { type: 'dispatch-started' });
const publication = (): ReleaseState => advanceRelease(dispatching(), { type: 'dispatch-result', candidate, outcome: 'accepted', runId: '123' });

describe('release orchestration', () => {
  test('progresses only on exact evidence through publication', () => {
    expect(advanceRelease(publication(), { type: 'publication', candidate, runId: '123', outcome: 'verified' }).phase).toBe('published');
    expect(advanceRelease(publication(), { type: 'publication', candidate, runId: '123', outcome: 'pending' }).phase).toBe('publication');
    expect(advanceRelease(publication(), { type: 'publication', candidate, runId: '123', outcome: 'failed' }).phase).toBe('rollback-signal');
  });
  test.each([{ checks: 'unknown' }, { checks: 'fail' }, { grant: 'denied' }, { grant: 'unknown' }, { workflow: 'unknown' }, { ownerReserved: 'blocked' }, { ownerReserved: 'unknown' }] as const)('holds unconfirmed gates %o', override => {
    expect(advanceRelease(detected(), { ...gates, ...override }).phase).toBe('held');
  });
  test('uncertain dispatch cannot be dispatched again and must be reconciled', () => {
    const state = advanceRelease(dispatching(), { type: 'dispatch-result', candidate, outcome: 'unknown' });
    expect(state.phase).toBe('reconcile-dispatch');
    expect(() => advanceRelease(state, { type: 'dispatch-started' })).toThrow();
    expect(advanceRelease(state, { type: 'dispatch-result', candidate, outcome: 'refused' }).phase).toBe('held');
  });
  test('rejects mismatched and out-of-order evidence', () => {
    expect(() => advanceRelease(detected(), { ...gates, candidate: { ...candidate, sourceSha: 'b'.repeat(40) } })).toThrow();
    expect(() => advanceRelease(publication(), { type: 'publication', candidate, runId: '124', outcome: 'verified' })).toThrow();
    expect(() => advanceRelease(dispatching(), { type: 'dispatch-result', candidate, outcome: 'accepted', runId: '' })).toThrow();
    expect(() => advanceRelease({ phase: 'detect' }, { type: 'detected', candidate: { ...candidate, workflow: '../publish.yml' } })).toThrow();
    expect(() => advanceRelease(detected(), { type: 'dispatch-started' })).toThrow();
  });
});
