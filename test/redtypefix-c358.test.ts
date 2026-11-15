import { describe, expect, test } from 'vitest';
import { advanceRelease, type ReleaseCandidate, type ReleaseState } from '../src/core/release/orchestration.js';

const candidate: ReleaseCandidate = {
  repository: 'ashlrai/phantom',
  sourceSha: 'a'.repeat(40),
  version: '3.30.24',
  workflow: '.github/workflows/publish-canonical-npm.yml',
};
const gates = { type: 'gates', candidate, checks: 'pass', grant: 'allowed', workflow: 'sanctioned', ownerReserved: 'clear' } as const;
const reconciling = (): ReleaseState =>
  advanceRelease(
    advanceRelease(
      advanceRelease({ phase: 'detect' }, { type: 'detected', candidate }),
      gates,
    ),
    { type: 'dispatch-started' },
  );

describe('release orchestration dispatch-result narrowing (redtypefix c358)', () => {
  test('an accepted dispatch-result with a well-formed run id advances to publication', () => {
    const state = advanceRelease(reconciling(), { type: 'dispatch-result', candidate, outcome: 'accepted', runId: '123' });
    expect(state.phase).toBe('publication');
    expect(state.phase === 'publication' ? state.runId : undefined).toBe('123');
  });

  test('refused and unknown dispatch-results never reach publication', () => {
    expect(advanceRelease(reconciling(), { type: 'dispatch-result', candidate, outcome: 'refused' }).phase).toBe('held');
    expect(advanceRelease(reconciling(), { type: 'dispatch-result', candidate, outcome: 'unknown' }).phase).toBe('reconcile-dispatch');
  });

  test('an accepted dispatch-result with a malformed run id throws', () => {
    expect(() => advanceRelease(reconciling(), { type: 'dispatch-result', candidate, outcome: 'accepted', runId: '0' })).toThrow();
  });
});
