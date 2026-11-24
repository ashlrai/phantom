import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readReleaseBacklog, BACKLOG_TTL, type BacklogOptions } from '../src/core/release/backlog.js';
import { CADENCE_REPOS } from '../src/core/release/cadence.js';
import { cmdFleetReleaseBacklog } from '../src/cli/fleet-release-backlog.js';

vi.mock('../src/core/release/git-backlog.js', () => ({
  readLocalGitRelease: vi.fn(async (repo: string) => ({ repo, latestTag: null, tagDate: null, commitsSinceTag: null, state: 'unknown', reason: 'no reachable tags' })),
}));
vi.mock('../src/core/release/remote-git-backlog.js', () => ({
  readRemoteGitRelease: vi.fn(async (local: { repo: string }) => ({ ...local, latestTag: 'v2', tagDate: '2026-11-20T00:00:00Z', commitsSinceTag: 21, state: 'due', reason: null, source: 'remote git' })),
}));
const now = Date.parse('2026-11-22T00:00:00Z');
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function stateDir() { const dir = await mkdtemp(join(tmpdir(), 'release-original-')); dirs.push(dir); return dir; }
const get: NonNullable<BacklogOptions['get']> = async path => {
  if (path.endsWith('/releases/latest')) return { tag_name: 'v1', published_at: '2026-11-01T00:00:00Z' };
  if (path.includes('/commits/')) return { sha: 'pinned' };
  if (!path.includes('/compare/')) return { default_branch: 'main' };
  const commit = (sha: string, parent: string, date: string) => ({ sha, parents: [{ sha: parent }], commit: { committer: { date } } });
  return { status: 'ahead', total_commits: 2, commits: path.endsWith('page=1')
    ? [commit('first', 'tag', '2026-11-18T00:00:00Z')]
    : [commit('last', 'first', '2026-11-21T00:00:00Z')] };
};
it('preserves pinned, paginated release evidence through cache and fleet CLI', async () => {
  const dir = await stateDir(), github = vi.fn(get);
  const report = await readReleaseBacklog({ now, stateDir: dir, get: github });
  expect(report.repos.map(row => row.repo)).toEqual(CADENCE_REPOS);
  expect(report.repos).toHaveLength(7);
  expect(report.repos[0]).toMatchObject({ latestTag: 'v1', releasedAt: '2026-11-01T00:00:00Z', mergedCommits: 2, oldestUnreleasedAgeDays: 4, verdict: 'due' });
  expect(github.mock.calls.filter(([path]) => path.includes('/compare/')).every(([path]) => path.includes('v1...pinned?per_page=100'))).toBe(true);
  expect(github.mock.calls.filter(([path]) => path.endsWith('page=2'))).toHaveLength(7);
  const calls = github.mock.calls.length;
  const cached = await readReleaseBacklog({ now: now + 1, stateDir: dir, cacheOnly: true, get: github });
  expect(cached.counts.due).toBe(7); expect(github).toHaveBeenCalledTimes(calls);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetReleaseBacklog(['--json'], async () => cached)).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0])).repos).toEqual(cached.repos);
});
it('keeps newer remote fallback cached and never refreshes it in cache-only mode', async () => {
  const dir = await stateDir(), github = vi.fn(async () => ({}));
  const fallback = await readReleaseBacklog({ now, stateDir: dir, get: github });
  expect(fallback.repos[0]).toMatchObject({ latestTag: 'v2', mergedCommits: 21, verdict: 'due', git: { source: 'remote git' } });
  const calls = github.mock.calls.length;
  expect((await readReleaseBacklog({ now: now + 1, stateDir: dir, cacheOnly: true, get: github })).counts.due).toBe(7);
  expect(github).toHaveBeenCalledTimes(calls);
  const expired = await readReleaseBacklog({ now: now + BACKLOG_TTL, stateDir: dir, cacheOnly: true, get: github });
  expect(expired.counts.unknown).toBe(7); expect(expired.repos[0]?.mergedCommits).toBeNull();
  expect(github).toHaveBeenCalledTimes(calls);
});
it('refreshes for the leader command and reads only that cache for compact snapshots', async () => {
  const dir = await stateDir();
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stop'));
  const backlog = await import('../src/core/release/backlog.js');
  const hosts = await import('../src/core/fleet/host-families.js');
  const latency = await import('../src/core/fleet/git-merge-latency.js');
  vi.spyOn(hosts, 'readHostFamilies').mockResolvedValue(hosts.groupHostFamilies(null));
  vi.spyOn(latency, 'readGitMergeLatency').mockResolvedValue(latency.mergeLatencyFromGit([], [], now / 1000));
  const github = vi.fn(get), real = backlog.readReleaseBacklog;
  const reader = vi.spyOn(backlog, 'readReleaseBacklog').mockImplementation(opts => real({ ...opts, now, stateDir: dir, get: github }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { cmdLeaderBrief } = await import('../src/cli/leader-brief.js');
  const { readCompactBrief } = await import('../src/core/fleet/leader-compact-brief.js');
  expect(await cmdLeaderBrief(['--json'])).toBe(0);
  expect(reader.mock.calls.some(([opts]) => !opts?.cacheOnly)).toBe(true);
  const calls = github.mock.calls.length;
  const brief = await readCompactBrief(dir, now);
  expect(brief.release.due).toBe(7);
  expect(reader.mock.calls.at(-1)?.[0]?.cacheOnly).toBe(true);
  expect(github).toHaveBeenCalledTimes(calls);
  vi.unstubAllEnvs();
});
