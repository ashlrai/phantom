import { expect, it } from 'vitest';
import { parseBridgeSubject, pathJobHistory } from '../src/core/fleet/path-job-history.js';

it('parses RQ and FIXUP subjects, with optional PRs', () => {
  expect(parseBridgeSubject('bridge(RQ-PHX-FOO01): some title (#3301)')).toEqual({ jobId: 'RQ-PHX-FOO01', pr: 3301, title: 'some title' });
  expect(parseBridgeSubject('bridge(FIXUP-CI-phantom-ci-1): repair')).toEqual({ jobId: 'FIXUP-CI-phantom-ci-1', pr: null, title: 'repair' });
  expect(parseBridgeSubject('plain commit (#12)')).toBeNull();
  expect(parseBridgeSubject('bridge(): invalid')).toBeNull();
});

it('skips plain commits, deduplicates newest first, and limits rows', async () => {
  const commits = ['bridge(A): newest (#3)', 'plain', 'bridge(A): older (#2)', 'bridge(B): second', 'bridge(C): third']
    .map((subject, i) => ({ subject, sha: String(i), date: '2026-01-01' }));
  const git = { log: async (path: string, limit: number) => {
    expect(path).toBe('a.ts'); expect(limit).toBe(2); return commits;
  } };
  expect(await pathJobHistory('a.ts', git, { limit: 2 })).toEqual([
    { jobId: 'A', pr: 3, title: 'newest', sha: '0', date: '2026-01-01' },
    { jobId: 'B', pr: null, title: 'second', sha: '3', date: '2026-01-01' },
  ]);
  await expect(pathJobHistory('a', git, { limit: 0 })).rejects.toThrow('limit');
});

it('defaults to twenty and handles empty history', async () => {
  expect(await pathJobHistory('a', { log: async (_path, limit) => { expect(limit).toBe(20); return []; } })).toEqual([]);
});
