import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatReleaseStatus, getLocalReleaseStatus, getReleaseStatus } from '../src/core/release/status.js';
import { cmdRelease } from '../src/cli/release.js';
import { cadenceMinutesFromEnv, TRAIN_SCHEMA } from '../src/core/release/train.js';

describe('release status', () => {
  it('reads local tags and default branch commits and reports missing evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-status-'));
    const path = join(root, 'phantom');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', path]);
      git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
      git('commit', '--allow-empty', '-qm', 'first'); git('tag', 'v1.0');
      git('commit', '--allow-empty', '-qm', 'second');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      const report = await getReleaseStatus({ root, repos: ['phantom', 'locus'] });
      expect(report.repos[0]).toMatchObject({ defaultBranch: 'main', latestTag: 'v1.0', ageDays: 0, unreleasedCommits: 1 });
      expect(report.repos[1]).toMatchObject({ latestTag: null, ageDays: null, unreleasedCommits: null });
      expect(formatReleaseStatus(report)).toContain('Published: unknown at unknown');
      expect(formatReleaseStatus(report)).toContain('Merged PRs since tag: unknown');
      git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
      expect((await getReleaseStatus({ root, repos: ['phantom'] })).repos[0]?.unreleasedCommits).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function fixture(at = '2026-11-17T12:00:00Z') {
  const root = mkdtempSync(join(tmpdir(), 'release-cadence-')); roots.push(root);
  const repoPath = join(root, 'phantom'), runsDir = join(root, 'runs'), dir = join(runsDir, 'release-sign', 'autorun');
  const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('commit', '--allow-empty', '-qm', 'release'); git('tag', 'v1.0.0'); const sha = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-qm', 'fix: first (#12)'); git('commit', '--allow-empty', '-qm', 'Merge pull request #13 from branch');
  git('commit', '--allow-empty', '-qm', 'direct maintenance');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: '@ashlr/phantom', version: '1.0.0' }));
  mkdirSync(dir, { recursive: true });
  const put = (name: string, value: unknown) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  put(`sha-${sha}.rc`, '0'); put(`sha-${sha}.log`, 'Reason: published\n'); put(`feed-${sha}.rc`, '0');
  put(`feed-${sha}.rel.json`, { tag_name: 'v1.0.0', draft: false, published_at: at });
  const receipt = { kind: 'desktop-update-channel-check', sha, tag: 'v1.0.0', state: 'verified-live', checkedAt: at, endpointHttp: 200 };
  put(`feed-${sha}.json`, receipt);
  return { deps: { root, repoPath, runsDir, cadenceMinutes: 60 }, sha, dir, put, receipt, git };
}
it.each(['2026-11-17T12:00:00Z', '2026-11-10T12:00:00Z'])('reports a fresh or stale release without inventing a new ETA: %s', async at => {
  const f = fixture(at), result = await getLocalReleaseStatus(f.deps);
  expect(result).toEqual({ latestPublishedTag: 'v1.0.0', publishedAt: new Date(at).toISOString(), recordedAt: new Date(at).toISOString(), signedAssets: true, updaterHttp: 200, mergedPrsSinceTag: 2,
    nextCandidate: { version: '1.0.1', eta: new Date(Date.parse(at) + 3600000).toISOString(), cadenceMinutes: 60 }, autorun: { rc: 0, reason: 'Reason: published', log: 'Reason: published' } });
  expect(JSON.stringify(await getLocalReleaseStatus(f.deps))).toBe(JSON.stringify(result));
  expect(Date.parse(result.nextCandidate.eta!) < Date.parse('2026-11-17T12:30:00Z')).toBe(at.startsWith('2026-11-10'));
  expect((await getLocalReleaseStatus({ ...f.deps, cadenceMinutes: undefined })).nextCandidate.cadenceMinutes).toBe(cadenceMinutesFromEnv());
});
it('reports missing assets, not a successful feed, and binds evidence to the tag', async () => {
  const f = fixture(); f.put(`feed-${f.sha}.rc`, '22');
  f.put(`feed-${f.sha}.json`, { ...f.receipt, state: 'failed', reason: 'asset-set-incomplete', endpointHttp: null });
  expect(await getLocalReleaseStatus(f.deps)).toMatchObject({ signedAssets: false, updaterHttp: null });
  f.put(`feed-${f.sha}.json`, { ...f.receipt, sha: 'wrong' });
  expect(await getLocalReleaseStatus(f.deps)).toMatchObject({ signedAssets: null, updaterHttp: null, recordedAt: null });
});
it('preserves rc=12 and its Reason, scrubs log secrets, and reports a missing log as unknown', async () => {
  const f = fixture(); f.put(`sha-${f.sha}.rc`, '12'); f.put(`sha-${f.sha}.log`, 'Reason: signature missing\npassword=fixture-only\nheld\n');
  const held = await getLocalReleaseStatus(f.deps);
  expect(held.autorun).toMatchObject({ rc: 12, reason: 'Reason: signature missing' });
  expect(held.autorun.log).not.toContain('fixture-only');
  rmSync(join(f.dir, `sha-${f.sha}.log`));
  expect((await getLocalReleaseStatus(f.deps)).autorun).toEqual({ rc: 12, reason: null, log: null });
});
it('keeps bare tags, shallow counts, missing publication times and invalid cadence unknown', async () => {
  const f = fixture(); rmSync(f.dir, { recursive: true });
  expect(await getLocalReleaseStatus({ ...f.deps, cadenceMinutes: 0 })).toMatchObject({ latestPublishedTag: null, publishedAt: null, signedAssets: null, updaterHttp: null, mergedPrsSinceTag: null, nextCandidate: { eta: null, cadenceMinutes: null }, autorun: { rc: null, reason: null, log: null } });
  writeFileSync(join(f.deps.runsDir, 'release-sign', 'last-released-tag'), 'v1.0.0');
  writeFileSync(join(f.deps.repoPath, '.git', 'shallow'), `${f.sha}\n`);
  expect(await getLocalReleaseStatus(f.deps)).toMatchObject({ latestPublishedTag: 'v1.0.0', publishedAt: null, mergedPrsSinceTag: null });
});
it('defaults the CLI to stable JSON, accepts text and preserves file inspection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-cli-')); roots.push(root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  expect(await cmdRelease(['status'])).toBe(0);
  expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ schema: 'phantom.release-status.v2', release: { autorun: { rc: null, reason: null } } });
  expect(await cmdRelease(['status', '--text'])).toBe(0); expect(String(out.mock.calls.at(-1)?.[0])).toContain('Published:');
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  expect(await cmdRelease(['status', '--text', '--json'])).toBe(2);
  expect(await cmdRelease(['status', 'extra'])).toBe(2);
});
it('inspects a supplied release state file whose relative name starts with a dash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-cli-file-')); roots.push(root);
  const previous = process.cwd();
  writeFileSync(join(root, '-release.json'), JSON.stringify({ schema: TRAIN_SCHEMA, stopped: true, steps: {}, stages: {} }));
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  process.chdir(root);
  try {
    expect(await cmdRelease(['status', '--file', '-release.json'])).toBe(0);
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      schema: TRAIN_SCHEMA, ok: true, state: { stopped: true },
    });
  } finally { process.chdir(previous); }
});
