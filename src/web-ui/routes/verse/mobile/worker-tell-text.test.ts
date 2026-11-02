import { describe, expect, it } from 'vitest';
import { workerTellPrefill } from './worker-tell-text.js';

const worker = { job: 'RQ-FAKE-31', lane: 'codex-personal', repo: 'phantom', ageSeconds: 3120, pr: null };

describe('workerTellPrefill', () => {
  it('includes context, age and the absence of a PR', () => {
    expect(workerTellPrefill(worker)).toBe('Re RQ-FAKE-31 (codex-personal, phantom): running 52 min with no PR. ');
  });
  it('includes the PR and hours, omitting missing context', () => {
    expect(workerTellPrefill({ ...worker, lane: null, repo: null, ageSeconds: 4320, pr: 'https://example.com/pull/31' }))
      .toBe('Re RQ-FAKE-31: running 1 h 12 min, PR https://example.com/pull/31. ');
  });
  it('handles either context field and an unknown age', () => {
    expect(workerTellPrefill({ ...worker, repo: null, ageSeconds: null })).toBe('Re RQ-FAKE-31 (codex-personal): running age unknown with no PR. ');
    expect(workerTellPrefill({ ...worker, lane: null, ageSeconds: null })).toBe('Re RQ-FAKE-31 (phantom): running age unknown with no PR. ');
  });
});
