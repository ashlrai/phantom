import { describe, expect, it } from 'vitest';
import { workerFromSnapshot } from './worker-snapshot-model.js';

const now = Date.parse('2026-10-31T00:12:00Z');
const job = 'RQ-FAKE-31';

describe('workerFromSnapshot', () => {
  it('reads a running worker and advances its snapshot age', () => {
    expect(workerFromSnapshot({ generatedAt: '2026-10-31T00:11:00Z', workers: [
      { job, repo: 'example/phantom', lane: 'fake-lane', tier: 'work', ageSeconds: 120 },
    ] }, job, now)).toEqual({ state: 'running', repo: 'example/phantom', lane: 'fake-lane', tier: 'work', ageText: '3 min', prUrl: null, mergedAs: null });
  });

  it('combines a publication with worker facts and a safe PR link', () => {
    expect(workerFromSnapshot({ workers: [{ job, repo: 'example/phantom', tier: 'work' }],
      publishesLastHour: [{ job, lane: 'fake-lane', url: 'https://github.com/example/phantom/pull/31', at: '2026-10-31T00:10:00Z' }],
    }, job, now)).toMatchObject({ state: 'published', repo: 'example/phantom', lane: 'fake-lane', tier: 'work', prUrl: 'https://github.com/example/phantom/pull/31' });
  });

  it('reads a claimed job and its age', () => {
    expect(workerFromSnapshot({ claimed: [{ job, lane: 'fake-lane', tier: 'work', at: '2026-10-31T00:10:00Z' }] }, job, now))
      .toMatchObject({ state: 'claimed', lane: 'fake-lane', tier: 'work', ageText: '2 min' });
  });

  it('identifies a merge by its title', () => {
    expect(workerFromSnapshot({ mergesLastHour: { items: [{ repo: 'example/phantom', number: 31, title: `Ship ${job}` }] } }, job, now))
      .toMatchObject({ state: 'merged', repo: 'example/phantom', mergedAs: 'example/phantom #31' });
  });

  it('returns null for an absent job or malformed payload', () => {
    for (const runs of [null, [], 'broken', {}, { workers: [null, 42, { job: 'other' }], mergesLastHour: { items: 'broken' } }]) {
      expect(workerFromSnapshot(runs, job, now)).toBeNull();
    }
  });

  it('narrows individual malformed fields and reports an incomplete merge as unknown', () => {
    expect(workerFromSnapshot({ workers: [{ job, repo: 42, lane: [], tier: null, ageSeconds: -1 }],
      mergesLastHour: { items: [{ title: job, repo: null, number: '31' }] },
    }, job, now)).toEqual({ state: 'unknown', repo: null, lane: null, tier: null, ageText: null, prUrl: null, mergedAs: null });
  });

  it.each(['http://github.com/example/phantom/pull/31', 'https://github.com.evil.test/example/phantom/pull/31',
    'https://github.com/example/phantom/issues/31', 'https://github.com/example/phantom/pull/31?x=1', 'javascript:alert(1)'])(
    'rejects unsafe or non-PR URLs: %s', url => {
    expect(workerFromSnapshot({ publishesLastHour: [{ job, url }] }, job, now)?.prUrl).toBeNull();
  });
});
