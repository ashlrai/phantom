import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as backlog from '../src/core/release/backlog.js';
import { cmdFleetReleaseBacklog } from '../src/cli/fleet-release-backlog.js';
import { cmdLeaderBrief } from '../src/cli/leader-brief.js';
import { readCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import * as hostFamilies from '../src/core/fleet/host-families.js';
import * as gitLatency from '../src/core/fleet/git-merge-latency.js';

let dir = '';
beforeEach(() => {
  vi.spyOn(hostFamilies, 'readHostFamilies').mockResolvedValue(hostFamilies.groupHostFamilies(null));
  vi.spyOn(gitLatency, 'readGitMergeLatency').mockResolvedValue(gitLatency.mergeLatencyFromGit([], [], Date.now() / 1000));
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); });
it('runs the recovered module and refreshes the explicit brief while compact reads only cache', async () => {
  dir = await mkdtemp(join(tmpdir(), 'backlog-owner-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stops.tsv'));
  await mkdir(join(dir, 'queue'));
  const until = Math.floor(Date.now() / 1000) + 3600;
  await writeFile(join(dir, 'queue/family-stop.tsv'), `^fake[0-9]+$\t${until}\tauto_0of3_merged_3_empty_fake\n`);
  const before = await readCompactBrief(dir);
  const get = vi.fn(async (path: string) => {
    if (path.endsWith('/releases/latest')) return { tag_name: 'v1', published_at: '2026-11-01T00:00:00Z' };
    if (path.includes('/commits/')) return { sha: 'pinned-head' };
    if (path.includes('/compare/')) return { status: 'identical', total_commits: 0, commits: [] };
    return { default_branch: 'main' };
  });
  const real = backlog.readReleaseBacklog;
  const read = vi.spyOn(backlog, 'readReleaseBacklog').mockImplementation(opts => real({ ...opts, stateDir: dir, get }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const resolved = resolveFleetSubcommand('release-backlog');
  expect(resolved).toEqual({ module: './fleet-release-backlog.js', exportName: 'cmdFleetReleaseBacklog' });
  const module = await import('../src/cli/fleet-release-backlog.js');
  expect(module[resolved!.exportName]).toBe(cmdFleetReleaseBacklog);
  expect(await module[resolved!.exportName](['--json'], () => real({ stateDir: dir, get }))).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0])).repos).toHaveLength(7);
  await rm(join(dir, 'release-backlog'), { recursive: true, force: true });
  get.mockClear();
  expect(await cmdLeaderBrief(['--json'])).toBe(0);
  expect(read.mock.calls.some(([opts]) => !opts?.cacheOnly)).toBe(true);
  expect(get.mock.calls.some(([path]) => path.includes('...pinned-head'))).toBe(true);
  get.mockClear();
  const brief = await readCompactBrief(dir);
  expect(get).not.toHaveBeenCalled();
  expect(brief.release.ok).toBe(7);
  for (const field of ['headline', 'families', 'lanes', 'hostLoad', 'mergeLatency', 'stopped'] as const) {
    expect(brief[field]).toEqual(before[field]);
  }
  expect(brief.stopped).toEqual([expect.objectContaining({ family: 'fake', auto: true, until })]);
});
it('reports incomplete comparison as unknown rather than zero', async () => {
  dir = await mkdtemp(join(tmpdir(), 'backlog-owner-'));
  const report = await backlog.readReleaseBacklog({ stateDir: dir, get: async path => {
    if (path.endsWith('/releases/latest')) return { tag_name: 'v1', published_at: '2026-11-01T00:00:00Z' };
    if (path.includes('/commits/')) return { sha: 'head' };
    if (path.includes('/compare/')) return { status: 'ahead', total_commits: 1, commits: [] };
    return { default_branch: 'main' };
  } });
  expect(report.counts.unknown).toBe(7);
  expect(report.repos.every(row => row.mergedCommits === null)).toBe(true);
});
it('keeps one missing repository unknown among seven bounded results', async () => {
  dir = await mkdtemp(join(tmpdir(), 'backlog-owner-'));
  const report = await backlog.readReleaseBacklog({ stateDir: dir, get: async path => {
    if (path.startsWith('repos/ashlrai/lexicon/')) throw new Error('Fake unavailable repository');
    if (path.endsWith('/releases/latest')) return { tag_name: 'v1', published_at: '2026-11-01T00:00:00Z' };
    if (path.includes('/commits/')) return { sha: 'head' };
    if (path.includes('/compare/')) return { status: 'identical', total_commits: 0, commits: [] };
    return { default_branch: 'main' };
  } });
  expect(report.repos).toHaveLength(7);
  expect(report.counts).toEqual({ ok: 6, due: 0, stale: 0, unknown: 1 });
  expect(report.repos.find(row => row.repo === 'lexicon')).toMatchObject({ verdict: 'unknown', mergedCommits: null, releasedAt: null });
});
it('keeps timed-out provider evidence unknown in the real command output', async () => {
  dir = await mkdtemp(join(tmpdir(), 'backlog-owner-'));
  vi.useFakeTimers();
  const get = vi.fn(async (_path: string, _signal: AbortSignal) => new Promise<unknown>(() => {}));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const pending = cmdFleetReleaseBacklog(['--json'], () => backlog.readReleaseBacklog({ stateDir: dir, get }));
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(14));
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toBe(0);
  const report = JSON.parse(String(log.mock.calls[0]![0]));
  expect(report.counts).toEqual({ ok: 0, due: 0, stale: 0, unknown: 7 });
  expect(report.repos.every((row: backlog.BacklogRow) => row.mergedCommits === null)).toBe(true);
  expect(get.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
});
