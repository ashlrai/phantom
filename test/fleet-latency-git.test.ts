import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { mergeLatencyFromGit, mergeLatencyLine, readGitMergeLatency } from '../src/core/fleet/git-merge-latency.js';
import { compactMergeLatency } from '../src/core/fleet/compact-brief-evidence.js';
import * as feed from '../src/core/fleet/merged-pr-feed.js';
import { cmdFleetBrief } from '../src/cli/fleet-brief.js';
import { readLeaderBrief } from '../src/core/fleet/leader-brief.js';
import { readCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import { groupHostFamilies } from '../src/core/fleet/host-families.js';
const now = 200_000;
const publish = (number: number, age: number) => ({ number, publishedAt: now - age });
const commit = (subject: string, age: number) => ({ subject, committedAt: now - age });
let dir: string;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); });
it('pairs squash and merge queue suffixes, deduplicates, and ignores mentions elsewhere', () => {
  const r = mergeLatencyFromGit([publish(1, 300), publish(1, 250), publish(2, 720), publish(3, 7200)],
    [commit('fix plain (#1)', 120), commit('Merge queued changes (#2)', 60), commit('mentions (#3) elsewhere', 1)], now);
  expect(r).toEqual({ seconds: 420, p90Seconds: 660, paired: 2, stillOpen: 1, oldestOpenAgeSeconds: 7200, reason: null });
  expect(mergeLatencyLine({ ...r, seconds: 180, paired: 41, stillOpen: 6 })).toBe('merge latency: median 3m, p90 11m (41 paired, 6 still open, oldest 2h)');
});
it('windows by merge time and never counts older landings or reversed times as open', () => {
  const r = mergeLatencyFromGit([publish(1, 100_000), publish(2, 100_000), publish(3, 60), publish(4, -1)],
    [commit('plain (#1)', 86_400), commit('plain (#2)', 90_000), commit('plain (#3)', 120)], now);
  expect(r).toMatchObject({ paired: 1, seconds: 13_600, p90Seconds: 13_600, stillOpen: 0, oldestOpenAgeSeconds: null });
});
it('returns null with a reason for empty input and keeps unpaired publications open', () => {
  expect(mergeLatencyFromGit([], [], now)).toMatchObject({ seconds: null, p90Seconds: null, paired: 0, stillOpen: 0, reason: expect.any(String) });
  expect(mergeLatencyFromGit([publish(1, 7200)], [], now)).toMatchObject({ seconds: null, stillOpen: 1, oldestOpenAgeSeconds: 7200 });
});
it('reads publication files and ledger times, keeps snapshot precedence, and prints the fleet brief', async () => {
  dir = await mkdtemp(join(tmpdir(), 'merge-latency-')); vi.stubEnv('ASHLR_RUNS_DIR', dir);
  const reading: feed.MergedPrFeed = { source: { kind: 'git', repoRoot: dir, ref: 'master' }, state: 'ok', reason: null, since: '', until: '',
    prs: [{ number: 1, sha: 'plain', title: 'plain', mergedAt: new Date((now - 120) * 1000).toISOString() }] };
  const git = vi.spyOn(feed, 'readMergedPrFeed').mockReturnValue(reading);
  await writeFile(join(dir, 'plain.publish'), 'RESULT PR https://github.com/ashlrai/phantom/pull/1\n');
  await utimes(join(dir, 'plain.publish'), new Date((now - 300) * 1000), new Date((now - 300) * 1000));
  const ledger = JSON.stringify({ event: 'publish', job: 'other', url: 'https://github.com/ashlrai/phantom/pull/2', ts: new Date((now - 100_000) * 1000).toISOString() });
  await mkdir(join(dir, 'metrics')); await writeFile(join(dir, 'metrics/jobs.jsonl'), ledger);
  expect(await compactMergeLatency(dir, ledger, now * 1000, null)).toMatchObject({ source: 'git', seconds: 180, paired: 1, stillOpen: 1, oldestOpenAgeSeconds: 100_000 });
  expect(git).toHaveBeenLastCalledWith(expect.objectContaining({ since: (now - 100_000) * 1000 }));
  expect(await readCompactBrief(dir, now * 1000, async () => groupHostFamilies(null))).toMatchObject({ medianOpenToMergeSeconds: 180, mergeLatencySource: 'git' });
  const read = () => readLeaderBrief({ now: () => now * 1000, readers: { installed: () => null, latest: () => null, needsMason: () => null, goals: () => [], lanes: () => [] } });
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBrief([], read)).toBe(0); expect(out.mock.calls[0]![0]).toContain('merge latency: median 3m, p90 3m (1 paired, 1 still open, oldest 28h)');
  expect(await cmdFleetBrief(['--json'], read)).toBe(0); expect(JSON.parse(String(out.mock.calls[1]![0]))).toMatchObject({ medianOpenToMergeSeconds: 180, mergeLatencySource: 'git' });
  const snapshot = [{ url: 'https://github.com/ashlrai/phantom/pull/1', createdAt: new Date((now - 600) * 1000).toISOString(), mergedAt: new Date(now * 1000).toISOString() }];
  git.mockClear();
  expect(await compactMergeLatency(dir, ledger, now * 1000, snapshot)).toMatchObject({ source: 'fleet/open-prs.json', seconds: 600 });
  expect(git).not.toHaveBeenCalled();
  git.mockReturnValue({ ...reading, state: 'incomplete', reason: 'shallow history' });
  expect(await readGitMergeLatency(dir, ledger, now * 1000)).toMatchObject({ seconds: 180, paired: 1, stillOpen: null, reason: 'shallow history' });
  git.mockReturnValue({ source: { kind: 'git', repoRoot: dir, ref: null }, state: 'unavailable', reason: 'git unavailable', since: '', until: '', prs: [] });
  expect(await readGitMergeLatency(dir, ledger, now * 1000)).toMatchObject({ seconds: null, stillOpen: null, reason: 'git unavailable' });
});
