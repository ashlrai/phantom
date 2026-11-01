import { describe, expect, it } from 'vitest';
import { hasThreadRefs, threadRefs } from './thread-refs.js';

describe('threadRefs', () => {
  it('deduplicates jobs and PRs in first-seen order', () => {
    expect(threadRefs('RQ-PHX-TWO then RQ-PHX-ONE, RQ-PHX-TWO; #2495 #42 #2495 #0 #1234567')).toEqual({
      jobs: ['RQ-PHX-TWO', 'RQ-PHX-ONE'], prs: [2495, 42],
    });
  });

  it('leaves ordinary sentences empty and rejects partial tokens', () => {
    const text = 'A plain sentence with no references.';
    expect(threadRefs(text)).toEqual({ jobs: [], prs: [] });
    expect(hasThreadRefs(text)).toBe(false);
    expect(threadRefs('prefixRQ-PHX-BAD #1234567 #0 #42abc')).toEqual({ jobs: [], prs: [] });
    expect(hasThreadRefs('See #123')).toBe(true);
  });

  it('caps each kind at twelve unique references', () => {
    const jobs = Array.from({ length: 14 }, (_, i) => `RQ-PHX-JOB${i}`);
    const prs = Array.from({ length: 14 }, (_, i) => `#${i + 1}`);
    expect(threadRefs([...jobs, ...prs].join(' '))).toEqual({
      jobs: jobs.slice(0, 12), prs: Array.from({ length: 12 }, (_, i) => i + 1),
    });
  });
});
