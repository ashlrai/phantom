import { expect, it } from 'vitest';
import { fleetMergePace } from '../src/core/fleet/merge-pace.js';

const now = Date.parse('2026-11-02T18:00:00Z');
const line = (job: string, hours: number, ttm_s: number, repo: string) => JSON.stringify({
  event: 'outcome', state: 'MERGED', job, ts: new Date(now - hours * 3_600_000).toISOString(),
  url: `https://github.com/${repo}/pull/7`, ttm_s,
});

it('builds per-repo and total rows from jsonl text and excludes rows older than 6h', async () => {
  const text = [line('a', 1, 360, 'example/one'), line('b', 2, 600, 'example/one'),
    line('c', 3, 120, 'example/two'), line('old', 7, 5, 'example/two'), 'not json'].join('\n');
  expect(await fleetMergePace(async () => text, now)).toEqual({
    schema: 'fleet.merge-pace.v1', known: true, window_hours: 6, rows: [
      { repo: 'example/one', merges: 2, merges_per_hour: 2 / 6, median_ttm_s: 480 },
      { repo: 'example/two', merges: 1, merges_per_hour: 1 / 6, median_ttm_s: 120 },
      { repo: 'total', merges: 3, merges_per_hour: 0.5, median_ttm_s: 360 },
    ],
  });
});

it('reports unknown, not zeros, when the reader returns null or throws', async () => {
  const unknown = { schema: 'fleet.merge-pace.v1', known: false, window_hours: 6, rows: null };
  expect(await fleetMergePace(async () => null, now)).toEqual(unknown);
  expect(await fleetMergePace(async () => { throw new Error('boom'); }, now)).toEqual(unknown);
});
