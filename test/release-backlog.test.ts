import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BACKLOG_TTL, backlogLines, readReleaseBacklog, type BacklogOptions } from '../src/core/release/backlog.js';
import { CADENCE_REPOS } from '../src/core/release/cadence.js';
import { cmdFleetReleaseBacklog } from '../src/cli/fleet-release-backlog.js';
const now = Date.parse('2026-11-21T12:00:00Z'), day = 86_400_000;
let stateDir: string;
beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), 'backlog-')); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await rm(stateDir, { recursive: true, force: true }); });
const commit = (sha: string, age: number, parent = 'tag') => ({ sha, parents: [{ sha: parent }], commit: { committer: { date: new Date(now - age * day).toISOString() } } });
const fixture = (count: number, age: number): NonNullable<BacklogOptions['get']> => async path => {
  if (path.endsWith('/releases/latest')) return { tag_name: 'tag', published_at: new Date(now - 10 * day).toISOString() };
  if (path.includes('/commits/')) return { sha: 'head' };
  if (!path.includes('/compare/')) return { default_branch: 'main' };
  return { status: count ? 'ahead' : 'identical', total_commits: count, commits: Array.from({ length: count }, (_, i) => commit(`word${i}`, age, i ? `word${i - 1}` : 'tag')) };
};
it.each([[0, 10, 'ok'], [19, 2.99, 'ok'], [20, 1, 'due'], [1, 3, 'due'], [1, 6.99, 'due'], [1, 7, 'stale']])('counts %i commits aged %s days as %s', async (count, age, verdict) => {
  const report = await readReleaseBacklog({ now, stateDir, get: fixture(Number(count), Number(age)) });
  expect(report.repos.map(r => r.repo)).toEqual(CADENCE_REPOS);
  expect(report.repos.every(r => r.verdict === verdict && r.mergedCommits === count)).toBe(true);
  expect(backlogLines(report)).toHaveLength(7);
});
it('reuses disk cache, recalculates age, and expires at ten minutes', async () => {
  const get = vi.fn(fixture(1, 3 - 1 / day));
  await readReleaseBacklog({ now, stateDir, get }); const calls = get.mock.calls.length;
  expect((await readReleaseBacklog({ now: now + 1000, stateDir, get })).counts.due).toBe(7);
  expect(get).toHaveBeenCalledTimes(calls);
  expect((await readReleaseBacklog({ now: now + BACKLOG_TTL, stateDir, cacheOnly: true })).counts.unknown).toBe(7);
  await readReleaseBacklog({ now: now + BACKLOG_TTL, stateDir, get }); expect(get.mock.calls.length).toBe(calls * 2);
});
it('paginates and measures mainline merge dates instead of old branch work', async () => {
  const get: NonNullable<BacklogOptions['get']> = async path => path.includes('/compare/')
    ? { status: 'ahead', total_commits: 2, commits: path.endsWith('page=1') ? [commit('branch', 10)] : [{ ...commit('merge', 1), parents: [{ sha: 'tag' }, { sha: 'branch' }] }] }
    : fixture(2, 1)(path, new AbortController().signal);
  expect((await readReleaseBacklog({ now, stateDir, get })).repos[0]).toMatchObject({ mergedCommits: 2, oldestUnreleasedAgeDays: 1, verdict: 'ok' });
});
it('bounds a hung reader to five seconds and reports unknown', async () => {
  vi.useFakeTimers();
  const get = vi.fn(async () => new Promise<unknown>(() => {}));
  const pending = readReleaseBacklog({ now, stateDir, get });
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(14));
  await vi.advanceTimersByTimeAsync(5000);
  expect((await pending).counts.unknown).toBe(7);
  expect(get.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
});
it('keeps malformed reads unknown and validates CLI arguments before reading', async () => {
  const report = await readReleaseBacklog({ now, stateDir, get: async () => ({}) });
  expect(report.counts.unknown).toBe(7);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {}), read = vi.fn(async () => report);
  expect(await cmdFleetReleaseBacklog(['--bad'], read)).toBe(2); expect(read).not.toHaveBeenCalled(); expect(error).toHaveBeenCalled();
  expect(await cmdFleetReleaseBacklog(['--json'], read)).toBe(0); expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(report);
});
