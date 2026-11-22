import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readGitRelease, releaseClonePaths } from '../src/core/release/git-backlog.js';
import { readReleaseBacklog } from '../src/core/release/backlog.js';
import { readCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import * as host from '../src/core/fleet/host-families.js';
import * as latency from '../src/core/fleet/git-merge-latency.js';

const now = Date.parse('2026-11-22T12:00:00Z'), day = 86_400_000;
let root: string, clone: string;
const git = (...args: string[]) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_DATE: new Date(now).toISOString(), GIT_COMMITTER_DATE: new Date(now).toISOString() } }).trim();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'git-backlog-')); clone = join(root, 'clone'); await mkdir(clone);
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('commit', '--allow-empty', '-m', 'initial'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  vi.stubEnv('PHANTOM_RELEASE_CLONES', JSON.stringify({ phantom: clone }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const tag = () => git('tag', 'v1.0.0');
function advance(count: number) {
  for (let i = 0; i < count; i++) git('commit', '--allow-empty', '-m', `change ${i}`);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
}
it.each([[0, 0, 'ok'], [20, 7, 'ok'], [21, 0, 'due'], [0, 7.01, 'due']])('reads %i commits and %s days as %s', async (count, age, state) => {
  tag(); advance(Number(count));
  expect(await readGitRelease('phantom', clone, now + Number(age) * day)).toEqual({ repo: 'phantom', latestTag: 'v1.0.0',
    tagDate: new Date(now).toISOString(), commitsSinceTag: count, state, reason: null });
});
it('reads annotated tag dates and ignores newer tags on an unmerged branch', async () => {
  git('tag', '-a', 'v1.0.0', '-m', 'release'); advance(1);
  git('checkout', '-b', 'side'); git('commit', '--allow-empty', '-m', 'side'); git('tag', 'v9.0.0');
  expect(await readGitRelease('phantom', clone, now)).toMatchObject({ latestTag: 'v1.0.0', commitsSinceTag: 1, state: 'ok', tagDate: new Date(now).toISOString() });
});
it('keeps missing clones, tags, refs and shallow history unknown with reasons', async () => {
  expect(await readGitRelease('absent', join(root, 'absent'), now)).toMatchObject({ state: 'unknown', reason: 'no local clone', commitsSinceTag: null });
  expect(await readGitRelease('phantom', clone, now)).toMatchObject({ state: 'unknown', reason: 'no reachable tags' });
  tag(); git('update-ref', '-d', 'refs/remotes/origin/main');
  expect(await readGitRelease('phantom', clone, now)).toMatchObject({ state: 'unknown', reason: 'no default-branch ref' });
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const shallow = join(root, 'shallow');
  execFileSync('git', ['clone', '--depth=1', `file://${clone}`, shallow], { stdio: 'pipe' });
  expect(await readGitRelease('phantom', shallow, now)).toMatchObject({ state: 'unknown', reason: 'shallow local clone', commitsSinceTag: null });
});
it('uses configured clones for absent cache and failed gh, preserving valid gh readings', async () => {
  tag(); advance(1);
  const options = { stateDir: root, now, get: async () => { throw new Error('gh unavailable'); } };
  const report = await readReleaseBacklog(options);
  expect(report.counts).toEqual({ ok: 1, due: 0, stale: 0, unknown: 6 });
  expect(report.repos[0]?.git).toMatchObject({ commitsSinceTag: 1, state: 'ok' });
  vi.spyOn(host, 'readHostFamilies').mockResolvedValue(host.groupHostFamilies(null));
  vi.spyOn(latency, 'readGitMergeLatency').mockResolvedValue(latency.mergeLatencyFromGit([], [], now / 1000));
  const brief = await readCompactBrief(root, now);
  expect(brief.release).toEqual(report.counts);
  expect(brief.releaseRepos[0]).toMatchObject({ latestTag: 'v1.0.0', commitsSinceTag: 1, state: 'ok', source: 'local git' });
  expect(brief.releaseRepos[1]).toMatchObject({ state: 'unknown', reason: 'no local clone' });
  expect(Buffer.byteLength(JSON.stringify(brief))).toBeLessThan(8192);
  const known = await readReleaseBacklog({ ...options, get: async path => path.endsWith('/releases/latest') ? { tag_name: 'v2', published_at: new Date(now).toISOString() }
    : path.includes('/commits/') ? { sha: 'head' } : path.includes('/compare/') ? { status: 'identical', total_commits: 0, commits: [] } : { default_branch: 'main' } });
  expect(known.repos[0]).toMatchObject({ latestTag: 'v2', verdict: 'ok' }); expect(known.repos[0]?.git).toBeUndefined();
});
it('handles invalid clone configuration without falling back to unrelated clones', () => {
  vi.stubEnv('PHANTOM_RELEASE_CLONES', 'invalid'); expect(releaseClonePaths('phantom')).toEqual([]);
});
it('uses origin/master when origin/HEAD is not recorded', async () => {
  tag(); git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD'); git('update-ref', '-d', 'refs/remotes/origin/main');
  expect(await readGitRelease('phantom', clone, now)).toMatchObject({ state: 'ok', commitsSinceTag: 0 });
});
