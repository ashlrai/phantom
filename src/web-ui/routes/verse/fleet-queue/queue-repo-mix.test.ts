import { describe, expect, it } from 'vitest';
import { isPhantomJob, repoMixByLane } from './queue-repo-mix.js';

describe('queue repo mix', () => {
  it('counts jobs by lane and sorts lanes by total', () => {
    expect(repoMixByLane([
      { lane: 'small', id: 'RQ-PHX-1' },
      { lane: 'personal', repo: 'phantom' },
      { lane: 'personal', repo: 'ashlrai/other' },
      { lane: 'personal', repo: 'ashlrai/other' },
    ])).toEqual([
      { lane: 'personal', total: 3, phantom: 1, other: 2, otherRepos: ['ashlrai/other'] },
      { lane: 'small', total: 1, phantom: 1, other: 0, otherRepos: [] },
    ]);
  });

  it('recognizes all Phantom jobs by id or case-insensitive owner-prefixed repo', () => {
    const jobs = [
      { lane: 'personal', id: 'RQ-PHX-1', repo: 'other' },
      { lane: 'personal', repo: 'SomeOwner/PHANTOM' },
    ];
    expect(jobs.every(isPhantomJob)).toBe(true);
    expect(repoMixByLane(jobs)).toEqual([
      { lane: 'personal', total: 2, phantom: 2, other: 0, otherRepos: [] },
    ]);
    expect(isPhantomJob({ lane: 'personal', repo: 'phantom-tools' })).toBe(false);
  });

  it('counts missing repo and id as other and labels the repo unknown', () => {
    expect(repoMixByLane([{ lane: 'personal' }, { lane: 'personal', repo: ' ' }])).toEqual([
      { lane: 'personal', total: 2, phantom: 0, other: 2, otherRepos: ['unknown'] },
    ]);
  });
});
