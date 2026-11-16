import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readEmptyJobs } from '../src/core/fleet/empty-jobs.js';

let dir: string; let runs: string; let wt: string;
const now = Date.parse('2026-11-09T13:00:00Z');
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'empty-reasons-'));
  runs = join(dir, 'runs'); wt = join(dir, 'wt');
  await mkdir(join(runs, 'metrics'), { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));
const seed = (ids: string[]) => writeFile(join(runs, 'metrics/jobs.jsonl'),
  ids.map(job => JSON.stringify({ event: 'outcome', empty: true, job, lane: 'claude', ts: '2026-11-09T12:00:00Z' })).join('\n'));

it('counts reasons and treats a missing log as other', async () => {
  await seed(['A', 'B', 'C']);
  await writeFile(join(runs, 'A.log'), 'usage limit reached');
  await writeFile(join(runs, 'B.log'), 'eslint crashed');
  const r = await readEmptyJobs(24, runs, wt, now);
  expect(r?.reasons?.by_reason).toEqual({ limit: 1, 'lint-env': 1, interrupted: 0, blocked: 0, other: 1 });
  expect(r?.reasons?.recent.map(j => j.id)).toEqual(['C', 'B', 'A']);
  expect(r?.reasons?.recent[2]).toEqual({ id: 'A', lane: 'claude', reason: 'limit' });
});
it('classifies only the newest 50 logs and lists at most 20', async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `J${i}`);
  await seed(ids);
  for (const id of ids) await writeFile(join(runs, `${id}.log`), 'rate limit');
  const r = await readEmptyJobs(24, runs, wt, now);
  expect(r?.total).toBe(60);
  expect(r?.reasons?.by_reason.limit).toBe(50);
  expect(r?.reasons?.recent).toHaveLength(20);
  expect(r?.reasons?.recent[0]?.id).toBe('J59');
});
it('reads only the last 64 KiB of a log', async () => {
  await seed(['T', 'U']);
  await writeFile(join(runs, 'T.log'), `usage limit\n${'x'.repeat(70_000)}\n`);
  await writeFile(join(runs, 'U.log'), `${'x'.repeat(70_000)}\nusage limit\n`);
  const r = await readEmptyJobs(24, runs, wt, now);
  expect(r?.reasons?.by_reason).toMatchObject({ limit: 1, other: 1 });
  expect(r?.reasons?.recent.find(j => j.id === 'T')?.reason).toBe('other');
});
it('does not fail when a log is unreadable', async () => {
  await seed(['D']);
  await mkdir(join(runs, 'D.log'));
  const r = await readEmptyJobs(24, runs, wt, now);
  expect(r?.reasons?.by_reason.other).toBe(1);
});
