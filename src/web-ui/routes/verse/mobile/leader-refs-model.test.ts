import { describe, expect, it } from 'vitest';
import { leaderRefs, prHref } from './leader-refs-model.js';

describe('leaderRefs', () => {
  it('deduplicates jobs and PRs in first-seen order', () => {
    expect(leaderRefs('RQ-PHX-TWO02 #2495 RQ-PHX-ONE01 #42 RQ-PHX-TWO02 #2495')).toEqual({
      jobs: ['RQ-PHX-TWO02', 'RQ-PHX-ONE01'], prs: [2495, 42],
    });
  });

  it('ignores invalid PR tokens and accepts the valid boundaries', () => {
    expect(leaderRefs('#0 #1000000 #0000001 #1 #999999 #12abc')).toEqual({ jobs: [], prs: [1, 999999] });
  });

  it('caps each kind at eight unique references', () => {
    const text = Array.from({ length: 10 }, (_, i) => `RQ-PHX-JOB${i} #${i + 1}`).join(' ');
    expect(leaderRefs(text)).toEqual({
      jobs: Array.from({ length: 8 }, (_, i) => `RQ-PHX-JOB${i}`),
      prs: Array.from({ length: 8 }, (_, i) => i + 1),
    });
  });

  it('returns empty lists for plain text', () => {
    expect(leaderRefs('Nothing to follow here.')).toEqual({ jobs: [], prs: [] });
  });
});

it('builds validated Phantom pull request links', () => {
  expect(prHref(2495)).toBe('https://github.com/ashlrai/phantom/pull/2495');
  expect(prHref(0)).toBeNull();
});
