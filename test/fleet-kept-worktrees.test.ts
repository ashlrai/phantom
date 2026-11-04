import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetKeptWorktrees, readKeptWorktrees } from '../src/cli/fleet-kept-worktrees.js';

let home: string;
const out = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const statusPath = () => join(home, '.ashlr-runs/queue/status.json');
async function fixture(jobs: string[], rows: unknown[] = []) {
  await writeFile(statusPath(), JSON.stringify({ kept_worktrees: jobs }));
  await writeFile(join(home, '.ashlr-runs/metrics/jobs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\nbroken\nnull\n');
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kept-worktrees-'));
  await mkdir(join(home, '.ashlr-runs/queue'), { recursive: true });
  await mkdir(join(home, '.ashlr-runs/metrics'), { recursive: true });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

it('joins fixture files through injected readers and chooses the newest outcome', async () => {
  const dir = join(home, 'Projects/ashlrai/wt/RQ-A');
  await mkdir(dir, { recursive: true });
  const created = (await lstat(dir)).birthtimeMs;
  await fixture(['RQ-A', 'RQ-B', 'RQ-C', 'RQ-A'], [
    { job: 'RQ-A', event: 'outcome', state: 'CLOSED', ts: '2026-11-02' },
    { job: 'RQ-A', event: 'outcome', state: 'OPEN', ts: '2026-11-01' },
    { job: 'RQ-A', event: 'finish', state: 'OPEN', ts: '2026-11-03' },
    { job: 'RQ-B', event: 'outcome', state: 'OPEN' },
  ]);
  const report = await readKeptWorktrees({ home, now: () => created + 7_200_000,
    readText: path => readFile(path, 'utf8'), stat: lstat });
  expect(report).toMatchObject({ doneCount: 1, red: false, jobs: [
    { job: 'RQ-A', ageHours: 2, state: 'CLOSED', done: true },
    { job: 'RQ-B', ageHours: null, state: 'OPEN', done: false },
    { job: 'RQ-C', ageHours: null, state: 'none', done: false },
  ] });
});

it.each([9, 10, 11])('returns red and exit 1 only at ten done jobs (count %i)', async count => {
  const jobs = Array.from({ length: count }, (_, i) => `RQ-${i}`);
  await fixture(jobs, jobs.map((job, i) => ({ job, event: 'outcome', state: i % 2 ? 'CLOSED' : 'MERGED' })));
  const log = out();
  expect(await cmdFleetKeptWorktrees(['--json'], { home })).toBe(count >= 10 ? 1 : 0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ doneCount: count, red: count >= 10 });
});

it('prints plain words and uses the last outcome when timestamps are absent', async () => {
  await fixture(['RQ-A'], ['MERGED', 'OPEN'].map(state => ({ job: 'RQ-A', event: 'outcome', state })));
  const log = out();
  expect(await cmdFleetKeptWorktrees([], { home })).toBe(0);
  expect(log).toHaveBeenCalledWith('RQ-A: unknown age; OPEN\nOK: 0 done kept worktrees');
});

it('reports none when the outcome file is absent and handles an empty list', async () => {
  await fixture(['RQ-A']);
  await rm(join(home, '.ashlr-runs/metrics/jobs.jsonl'));
  expect((await readKeptWorktrees({ home })).jobs[0]?.state).toBe('none');
  await writeFile(statusPath(), '{"kept_worktrees":[]}');
  expect(await readKeptWorktrees({ home })).toMatchObject({ jobs: [], red: false });
});

it('rejects invalid status, unsafe job paths, and bad arguments without reading files', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const value of ['broken', '{}', '{"kept_worktrees":["../escape"]}']) {
    await writeFile(statusPath(), value);
    expect(await cmdFleetKeptWorktrees(['--json'], { home })).toBe(1);
  }
  const readText = vi.fn();
  expect(await cmdFleetKeptWorktrees(['--wat'], { readText })).toBe(2);
  out();
  expect(await cmdFleetKeptWorktrees(['--help'], { readText })).toBe(0);
  expect(readText).not.toHaveBeenCalled();
});
