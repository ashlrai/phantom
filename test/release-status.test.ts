import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatReleases, formatReleaseStatus, readReleaseRows, releaseTagLines, getLocalReleaseStatus, getReleases, getReleaseStatus, releaseCadence, releaseRoots, releasesLeaderLine, RELEASES_SCHEMA } from '../src/core/release/status.js';
import { cmdRelease, cmdReleases } from '../src/cli/release.js';
import { cadenceMinutesFromEnv, TRAIN_SCHEMA } from '../src/core/release/train.js';

import * as remoteTags from '../src/core/release/remote-git-backlog.js';
beforeEach(() => { vi.spyOn(remoteTags, 'readRemoteGitRelease').mockImplementation(async row => ({ ...row, reason: 'remote tags unavailable' })); });

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
      expect(report.repos[0]).toMatchObject({ readable: true, mergedPrsSinceTag: 0 });
      expect(report.repos[1]).toMatchObject({ readable: false, taggedAt: null, mergedPrsSinceTag: null });
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

describe('release cadence', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const daysAgo = (days: number) => new Date(now - days * 86400000).toISOString();
  const one = (latestTag: string | null, days: number | null, mergedPrsSinceTag: number | null, readable?: boolean) =>
    releaseCadence([{ repo: 'ashlrai/locus', latestTag, taggedAt: days === null ? null : daysAgo(days), mergedPrsSinceTag, readable }], now).repos[0]!;

  it('is fresh inside both limits, and at exactly 7 days and 50 PRs', () => {
    expect(one('v1.0.0', 2, 3)).toEqual({ repo: 'ashlrai/locus', latestTag: 'v1.0.0', taggedAt: daysAgo(2), ageDays: 2, mergedPrsSince: 3, recentPrs: null, reason: null, verdict: 'fresh', suggestion: 'locus: 3 PRs since v1.0.0 2 days ago; fresh' });
    expect(one('v1.0.0', 7, 50)).toMatchObject({ ageDays: 7, verdict: 'fresh' });
    expect(one('v1.0.0', 1, 1).suggestion).toBe('locus: 1 PR since v1.0.0 1 day ago; fresh');
  });
  it('is due by age, and by count', () => {
    expect(one('v1.0.0', 8, 3)).toMatchObject({ verdict: 'due', suggestion: 'locus: 3 PRs since v1.0.0 8 days ago; release due' });
    expect(one('v0.9.1', 2, 51)).toMatchObject({ verdict: 'due', suggestion: 'locus: 51 PRs since v0.9.1 2 days ago; release due' });
    expect(one('v0.9.1', 11, 62).suggestion).toBe('locus: 62 PRs since v0.9.1 11 days ago; release due');
    expect(one('v1.0.0', 30, null)).toMatchObject({ verdict: 'due', suggestion: 'locus: unknown PRs since v1.0.0 30 days ago; release due' });
  });
  it('does not ask for a release when nothing merged since an old tag', () => {
    expect(one('v1.0.0', 40, 0)).toMatchObject({ verdict: 'fresh', suggestion: 'locus: 0 PRs since v1.0.0 40 days ago; nothing to release' });
  });
  it('reports no tags as no release yet and missing facts as unknown', () => {
    expect(one(null, null, null)).toMatchObject({ latestTag: null, ageDays: null, verdict: 'no release yet', suggestion: 'locus: no release yet' });
    expect(one(null, null, 12).suggestion).toBe('locus: no release yet; 12 PRs merged');
    expect(one(null, null, null, false)).toMatchObject({ verdict: 'unknown', suggestion: 'locus: release state unknown (local clone missing or incomplete)' });
    expect(one('v1.0.0', 2, null)).toMatchObject({ verdict: 'unknown', suggestion: 'locus: unknown PRs since v1.0.0 2 days ago; cannot tell if a release is due' });
    expect(one('v1.0.0', null, 3)).toMatchObject({ ageDays: null, verdict: 'unknown' });
    expect(one('v1.0.0', 2, -4)).toMatchObject({ mergedPrsSince: null, verdict: 'unknown' });
  });
  it('returns a stable empty report for empty input', () => {
    const report = releaseCadence([], now);
    expect(report).toEqual({ schema: 'phantom.releases.v1', version: 1, checkedAt: '2026-11-18T12:00:00.000Z', dueWhen: { days: 7, mergedPrs: 50 },
      counts: { fresh: 0, due: 0, 'no release yet': 0, unknown: 0 }, repos: [], next: null });
    expect(formatReleases(report)).toBe('Releases: no repos to check.\n');
  });
  it('names the single most overdue repo as next and only reports', () => {
    const report = releaseCadence([
      { repo: 'ashlrai/phantom', latestTag: 'v3.1.0', taggedAt: daysAgo(9), mergedPrsSinceTag: 20 },
      { repo: 'ashlrai/locus', latestTag: 'v0.9.1', taggedAt: daysAgo(3), mergedPrsSinceTag: 200 },
      { repo: 'ashlrai/lexicon', latestTag: null, taggedAt: null, mergedPrsSinceTag: null },
      { repo: 'ashlrai/ashlr-md', latestTag: 'v0.2.0', taggedAt: daysAgo(1), mergedPrsSinceTag: 2 },
    ], now);
    expect(report.counts).toEqual({ fresh: 1, due: 2, 'no release yet': 1, unknown: 0 });
    expect(report.next).toMatchObject({ repo: 'ashlrai/locus', verdict: 'due', mergedPrsSince: 200 });
    expect(report.next?.action).toContain('never tags or publishes');
    const text = formatReleases(report);
    expect(text).toContain('Releases: 2 due, 1 fresh, 1 with no release yet, 0 unknown');
    expect(text).toContain('  phantom: 20 PRs since v3.1.0 9 days ago; release due');
    expect(text).toContain('Next: ashlrai/locus.');
    expect(formatReleases(releaseCadence([{ repo: 'ashlrai/phantom', latestTag: 'v1', taggedAt: daysAgo(1), mergedPrsSinceTag: 1 }], now))).toContain('Next: nothing is due.');
  });
  it('reads tag date and merged PRs from a local clone, and a clone with no tags as no release yet', () => {
    const f = fixture('2026-11-08T12:00:00Z');
    execFileSync('git', ['init', '-q', '-b', 'main', join(f.deps.root, 'locus')]);
    const report = getReleases({ root: f.deps.root, repos: ['phantom', 'locus', 'lexicon'], now });
    expect(report.repos.map(row => [row.repo, row.latestTag, row.ageDays, row.mergedPrsSince, row.verdict])).toEqual([
      ['ashlrai/phantom', 'v1.0.0', 10, 2, 'due'], ['ashlrai/locus', null, null, null, 'no release yet'], ['ashlrai/lexicon', null, null, null, 'unknown']]);
    expect(report.next?.repo).toBe('ashlrai/phantom');
  });
  it('counts a shallow clone only when its history reaches the tag, and never calls a cut-off clone unreleased', () => {
    const f = fixture('2026-11-17T12:00:00Z'), later = '2026-11-17T18:00:00Z';
    const git = (...args: string[]) => execFileSync('git', ['-C', f.deps.repoPath, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: later, GIT_COMMITTER_DATE: later } });
    git('commit', '--allow-empty', '-qm', 'feat: next (#14)'); git('tag', 'v1.1.0');
    git('commit', '--allow-empty', '-qm', 'fix: after (#15)'); git('commit', '--allow-empty', '-qm', 'tidy');
    const clone = (name: string, depth: number) => execFileSync('git', ['clone', '-q', '--depth', String(depth), `file://${f.deps.repoPath}`, join(f.deps.root, name)], { stdio: 'ignore' });
    clone('locus', 4); clone('lexicon', 2);
    const report = getReleases({ root: f.deps.root, repos: ['locus', 'lexicon'], now });
    expect(report.repos.map(row => [row.latestTag, row.mergedPrsSince, row.verdict])).toEqual([['v1.1.0', 1, 'fresh'], [null, null, 'unknown']]);
    // Cut the history off inside the range: the count is then unknown, not a low guess.
    const locus = (...args: string[]) => execFileSync('git', ['-C', join(f.deps.root, 'locus'), ...args], { stdio: 'ignore' });
    locus('fetch', '-q', '--depth', '1', 'origin', 'tag', 'v1.0.0'); locus('tag', '-d', 'v1.1.0');
    expect(getReleases({ root: f.deps.root, repos: ['locus'], now }).repos[0]).toMatchObject({ latestTag: 'v1.0.0', mergedPrsSince: null, verdict: 'unknown' });
  });
  it('phm releases prints the report, has versioned JSON and rejects other arguments', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true), err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(cmdReleases(['--json'])).toBe(0);
    const json = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
    // HOME is a scratch directory here, so no clone is readable: every repo is unknown, none is invented.
    expect(json).toMatchObject({ schema: RELEASES_SCHEMA, version: 1, next: null, counts: { unknown: 7 } });
    expect(json.repos.map((row: { repo: string }) => row.repo)).toEqual(['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-plugin', 'ashlr-stack', 'ashlr-md'].map(name => `ashlrai/${name}`));
    expect(cmdReleases([])).toBe(0);
    expect(String(out.mock.calls.at(-1)?.[0])).toContain('Releases: 0 due, 0 fresh, 0 with no release yet, 7 unknown');
    expect(cmdReleases(['--help'])).toBe(0);
    expect(cmdReleases(['--tag'])).toBe(2);
    expect(cmdReleases(['--json', '--json'])).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0])).toBe('phm releases [--json]\n');
  });
});

describe('release discovery roots and unreadable repos', () => {
  const made: string[] = [];
  afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'release-roots-')); made.push(dir); return dir; };
  /** A clone with one tag and `after` commits since it; `ref: false` leaves origin/HEAD unset, `tag: false` skips the tag. */
  function clone(root: string, name: string, opts: { after?: number; ref?: boolean; tag?: boolean } = {}) {
    const path = join(root, name);
    const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'ignore' });
    execFileSync('git', ['init', '-q', '-b', 'main', path]);
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('commit', '--allow-empty', '-qm', 'first');
    if (opts.tag !== false) git('tag', 'v1.0.0');
    for (let n = 1; n <= (opts.after ?? 0); n += 1) git('commit', '--allow-empty', '-qm', `change ${n} (#${n})`);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    if (opts.ref !== false) git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  }
  const SEVEN = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-plugin', 'ashlr-stack', 'ashlr-md'];

  it('finds all seven repos', () => {
    const root = scratch();
    for (const name of SEVEN) clone(root, name, { after: 1 });
    const report = getReleases({ root, installed: () => ({ version: null, revision: null }) as never });
    expect(report.repos.map(row => row.repo)).toEqual(SEVEN.map(name => `ashlrai/${name}`));
    expect(report.counts).toMatchObject({ fresh: 7, unknown: 0 });
    expect(report.repos.every(row => row.reason === null)).toBe(true);
  });

  it('lists a missing repo as not found with every path it tried', () => {
    const first = scratch(), second = scratch();
    for (const name of SEVEN.filter(name => name !== 'locus')) clone(first, name, { after: 1 });
    const report = getReleases({ roots: [first, second], installed: () => ({ version: null, revision: null }) as never });
    const locus = report.repos.find(row => row.repo === 'ashlrai/locus')!;
    expect(locus.verdict).toBe('unknown');
    expect(locus.reason).toBe(`not found (tried ${join(first, 'locus')}, ${join(second, 'locus')})`);
    expect(locus.suggestion).toBe(`locus: not found (tried ${join(first, 'locus')}, ${join(second, 'locus')})`);
    expect(report.counts).toMatchObject({ fresh: 6, unknown: 1 });
  });

  it('reads unknown with a reason, and does not throw, when there is no default-branch ref', () => {
    const root = scratch();
    clone(root, 'phantom', { after: 3, ref: false });
    const row = getReleases({ root, repos: ['phantom'], installed: () => ({ version: null, revision: null }) as never }).repos[0]!;
    expect(row).toMatchObject({ verdict: 'unknown', latestTag: 'v1.0.0', mergedPrsSince: null });
    expect(row.reason).toMatch(/^no default-branch ref/);
    expect(row.suggestion).toContain('cannot tell if a release is due (no default-branch ref');
  });

  it('reads "no release yet" with the reason when the clone has no tags', () => {
    const root = scratch();
    clone(root, 'lexicon', { after: 2, tag: false });
    const row = getReleases({ root, repos: ['lexicon'] }).repos[0]!;
    expect(row).toMatchObject({ verdict: 'no release yet', latestTag: null, reason: 'no tags in this clone' });
    expect(row.suggestion).toBe('lexicon: no release yet (no tags in this clone)');
  });

  it('reads the configured repo roots before the default folder, without writing the config', () => {
    const home = scratch(), configured = join(scratch(), 'code');
    mkdirSync(configured, { recursive: true });
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    const configFile = join(home, '.ashlr', 'config.json');
    writeFileSync(configFile, JSON.stringify({ version: 1, roots: [configured] }));
    clone(configured, 'locus', { after: 1 });
    clone(join(home, 'Projects', 'ashlrai'), 'lexicon', { after: 1 });
    vi.stubEnv('HOME', home);
    expect(releaseRoots()).toEqual([configured, join(home, 'Projects', 'ashlrai')]);
    const report = getReleases({ repos: ['locus', 'lexicon', 'ashlr-md'] });
    expect(report.repos.map(row => row.verdict)).toEqual(['fresh', 'fresh', 'unknown']);
    expect(report.repos[2]!.reason).toBe(`not found (tried ${join(configured, 'ashlr-md')}, ${join(home, 'Projects', 'ashlrai', 'ashlr-md')})`);
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ version: 1, roots: [configured] });
  });

  it('writes the one Leader card line', () => {
    const now = Date.parse('2026-11-20T00:00:00Z'), day = (n: number) => new Date(now - n * 86_400_000).toISOString();
    expect(releasesLeaderLine(releaseCadence([{ repo: 'ashlrai/locus', latestTag: 'v1.4.0', taggedAt: day(9), mergedPrsSinceTag: 23 }], now))).toBe('Release due: locus (23 PRs since v1.4.0, 9 days)');
    expect(releasesLeaderLine(releaseCadence([{ repo: 'ashlrai/locus', latestTag: 'v1.4.0', taggedAt: day(1), mergedPrsSinceTag: 2 }], now))).toBe('Releases: all fresh');
    expect(releasesLeaderLine(releaseCadence([{ repo: 'ashlrai/locus', latestTag: 'v1.4.0', taggedAt: day(1), mergedPrsSinceTag: 2 }, { repo: 'ashlrai/lexicon', latestTag: null, taggedAt: null, mergedPrsSinceTag: null, readable: false }], now))).toBe('Releases: none due (1 unknown)');
    expect(releasesLeaderLine(null)).toBe('Releases: unknown');
  });
});

describe('release tag lines in plain words', () => {
  const made: string[] = [];
  afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function repo(root: string, name: string, tag: string | null, after: number) {
    const path = join(root, name);
    const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'ignore' });
    execFileSync('git', ['init', '-q', '-b', 'main', path]);
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('commit', '--allow-empty', '-qm', 'first');
    if (tag) git('tag', tag);
    for (let i = 0; i < after; i++) git('commit', '--allow-empty', '-qm', `change ${i}`);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    return git;
  }

  it('says tag, age and commits since; never released; and not checked out here', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-lines-')); made.push(root);
    repo(root, 'phantom', 'v0.42.1', 3);
    repo(root, 'locus', null, 1);
    const lines = releaseTagLines(readReleaseRows({ root, repos: ['phantom', 'locus', 'lexicon'] }));
    expect(lines).toEqual([
      'phantom: v0.42.1, today, 3 commits since',
      'locus: never released',
      'lexicon: not checked out here',
    ]);
  });

  it('ignores a tag that is not on the default branch and reports unknown when the clone has no default-branch ref', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-lines-')); made.push(root);
    const git = repo(root, 'phantom', 'v1.0.0', 2);
    git('checkout', '-q', '-b', 'side'); git('commit', '--allow-empty', '-qm', 'side work'); git('tag', 'v9.9.9'); git('checkout', '-q', 'main');
    expect(releaseTagLines(readReleaseRows({ root, repos: ['phantom'] }))).toEqual(['phantom: v1.0.0, today, 2 commits since']);
    git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    expect(releaseTagLines(readReleaseRows({ root, repos: ['phantom'] }))[0]).toMatch(/^phantom: v\d+\.\d+\.\d+, today, unknown since$/);
  });
});
