import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readMergedPrFeed } from '../src/core/fleet/merged-pr-feed.js';
import { readLeaderBrief } from '../src/core/fleet/leader-brief.js';
import { cmdFleetBrief } from '../src/cli/fleet-brief.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const now = Date.parse('2026-11-21T18:00:00Z');
let repoRoot: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = (title: string, at: string) => execFileSync('git', ['-C', repoRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
  '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', title, `--date=${at}`],
{ env: { ...process.env, GIT_COMMITTER_DATE: at }, stdio: 'pipe' });
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'merged-pr-feed-'));
  git('init', '-b', 'trunk');
  commit('initial', '2026-11-19T10:00:00Z');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/trunk');
});
afterEach(() => { vi.restoreAllMocks(); rmSync(repoRoot, { recursive: true, force: true }); });

it('reads squash and merge PRs once from the default branch within 24h, using only local git', () => {
  commit('old (#1)', '2026-11-20T17:59:59Z');
  git('checkout', '-b', 'feature');
  commit('nested (#99)', '2026-11-21T10:00:00Z');
  git('checkout', 'trunk');
  execFileSync('git', ['-C', repoRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false',
    'merge', '--no-ff', 'feature', '-m', 'Merge pull request #2 from fixture/feature'],
  { env: { ...process.env, GIT_COMMITTER_DATE: '2026-11-21T12:00:00Z' }, stdio: 'pipe' });
  commit('squashed (#3)', '2026-11-21T13:00:00Z');
  commit('duplicate (#3)', '2026-11-21T14:00:00Z');
  commit('direct commit references #55', '2026-11-21T15:00:00Z');
  commit('future (#4)', '2026-11-22T12:00:00Z');
  git('checkout', '-b', 'unmerged');
  commit('not merged (#5)', '2026-11-21T16:00:00Z');
  const run = vi.mocked(execFileSync).mockClear();
  const feed = readMergedPrFeed({ repoRoot, now });
  expect(feed.state).toBe('ok');
  expect(feed.source).toEqual({ kind: 'git', repoRoot, ref: 'refs/heads/trunk' });
  expect(feed.prs.map(pr => pr.number)).toEqual([3, 2]);
  expect(feed.prs[0]).toMatchObject({ title: 'duplicate (#3)', mergedAt: '2026-11-21T14:00:00.000Z', sha: expect.stringMatching(/^[a-f0-9]{40}$/) });
  expect(run).toHaveBeenCalled();
  expect(run.mock.calls.every(([program, args]) => program === 'git' && !args?.includes('fetch'))).toBe(true);
});

it('includes both window boundaries even across commits with skewed timestamps', () => {
  commit('before window (#9)', '2026-11-20T17:59:59Z');
  commit('start (#10)', '2026-11-20T18:00:00Z');
  commit('skewed old date', '2026-11-19T12:00:00Z');
  commit('end (#11)', '2026-11-21T18:00:00Z');
  expect(readMergedPrFeed({ repoRoot, now }).prs.map(pr => pr.number)).toEqual([11, 10]);
  expect(readMergedPrFeed({ repoRoot, now, since: now - 172_800_000 }).prs.map(pr => pr.number)).toEqual([11, 10, 9]);
});

it('distinguishes an empty window from missing refs, missing repositories, and shallow history', () => {
  expect(readMergedPrFeed({ repoRoot, now })).toMatchObject({ state: 'ok', prs: [], reason: null });
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  expect(readMergedPrFeed({ repoRoot, now })).toMatchObject({ state: 'unavailable', prs: [] });
  expect(readMergedPrFeed({ repoRoot: join(repoRoot, 'missing'), now }).state).toBe('unavailable');
  git('branch', 'main');
  expect(readMergedPrFeed({ repoRoot, now }).source.ref).toBe('refs/heads/main');
  const shallow = join(repoRoot, 'shallow');
  git('clone', '--depth=1', '--no-local', repoRoot, shallow);
  expect(readMergedPrFeed({ repoRoot: shallow, now })).toMatchObject({ state: 'incomplete', reason: expect.stringContaining('Shallow') });
});

it('exposes the feed and its source through the existing brief CLI without gh', async () => {
  commit('shipped (#42)', '2026-11-21T12:00:00Z');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const read = () => readLeaderBrief({ repoRoot, now: () => now, readers: {
    installed: () => null, latest: () => null, needsMason: () => null, goals: () => [], lanes: () => [],
  } });
  expect(await cmdFleetBrief(['--json'], read)).toBe(0);
  const brief = JSON.parse(log.mock.calls[0]![0] as string);
  expect(brief).toMatchObject({ merges24h: 1, mergedPrs: { state: 'ok', prs: [{ number: 42 }] } });
  expect(brief.text).toContain('Source: local git default branch (ok)');
  rmSync(repoRoot, { recursive: true, force: true });
  expect(await read()).toMatchObject({ merges24h: null, mergedPrs: { state: 'unavailable' } });
});
