import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdSelf } from '../src/cli/self.js';
import {
  FLEET_CAPABILITIES, SELF_DRIFT_SCHEMA, countBehind, driftLine, formatSelfDrift, narrowSelfDrift, readBehindReleases, readInstalledBuild, readSelfDrift,
  type GitRead, type HelpProbe, type InstalledBuild,
} from '../src/core/release/drift.js';
import { getReleases, releaseCadence } from '../src/core/release/status.js';

const NOW = () => new Date('2026-11-18T12:00:00Z');
const TAGS = 'v3.2.0\t2026-11-17T10:00:00Z\nv3.1.0\t2026-11-10T10:00:00Z\nv3.0.0\t2026-11-01T10:00:00Z\nv3.1.0-beta\t2026-11-09T10:00:00Z';
/** A clone with three releases and no readable master. */
const tagsOnly: GitRead = args => args[0] === 'for-each-ref' ? TAGS : null;
const installed = (version: string | null, bin: string | null = '/fake/phm'): () => InstalledBuild => () => ({ bin, version, revision: null });
/** The installed CLI answers every capability with its proof text. */
const allLive: HelpProbe = async argv => ({ code: 0, output: FLEET_CAPABILITIES.find(cap => cap.argv.join(' ') === argv.join(' '))!.proof.join(' '), timedOut: false });

const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'drift-')); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('phm self drift', () => {
  it('up to date: newest release installed and every fleet feature live, as versioned JSON', async () => {
    const drift = await readSelfDrift({ git: tagsOnly, installed: installed('3.2.0'), probe: allLive, now: NOW });
    expect(drift).toMatchObject({
      schema: SELF_DRIFT_SCHEMA, version: 1, checkedAt: '2026-11-18T12:00:00.000Z',
      installed: { version: '3.2.0', revision: 'unknown' }, latestRelease: { tag: 'v3.2.0', at: '2026-11-17T10:00:00.000Z' },
      master: { revision: 'unknown', at: 'unknown' }, behindReleases: 0, behindCommits: 'unknown', oldestUnshippedMergeAt: 'unknown',
      missingFeatures: [], unknownFeatures: [], line: 'Up to date',
    });
    expect(drift.liveFeatures).toEqual(['recut-check', 'yield-stop-list', 'stop-file', 'pulse', 'decisions', 'leader-replies', 'model-check']);
    expect(drift.features[0]).toEqual({ name: 'recut-check', command: 'phm recut check --help', state: 'live' });
    expect(narrowSelfDrift(JSON.parse(JSON.stringify(drift)))).not.toBeNull();
  });

  it('behind by releases, with master commits and the oldest unshipped merge from a real clone', async () => {
    const repo = scratch();
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const commit = (subject: string, at: string) => execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', subject],
      { env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    commit('first', '2026-11-01T10:00:00Z'); git('tag', 'v3.0.0'); const shipped = git('rev-parse', 'HEAD');
    commit('fix: one (#1)', '2026-11-05T10:00:00Z'); git('tag', 'v3.1.0');
    commit('fix: two (#2)', '2026-11-08T10:00:00Z'); git('tag', 'v3.2.0');
    commit('fix: three (#3)', '2026-11-12T10:00:00Z');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    const drift = await readSelfDrift({ repo, installed: () => ({ bin: '/fake/phm', version: '3.0.0', revision: shipped }), probe: allLive, now: NOW });
    expect(drift).toMatchObject({ behindReleases: 2, behindCommits: 3, oldestUnshippedMergeAt: '2026-11-05T10:00:00.000Z', latestRelease: { tag: 'v3.2.0' },
      master: { revision: git('rev-parse', 'HEAD'), at: '2026-11-12T10:00:00.000Z' }, line: '2 releases behind, 0 fleet features not live yet' });
    // A build commit the clone does not have counts nothing: unknown, not zero.
    const stranger = await readSelfDrift({ repo, installed: () => ({ bin: null, version: '3.0.0', revision: 'f'.repeat(40) }), now: NOW });
    expect(stranger).toMatchObject({ behindCommits: 'unknown', oldestUnshippedMergeAt: 'unknown' });
    expect(readBehindReleases({ repo, installed: installed('3.1.0') })).toBe(1);
    // A shallow clone cut inside the range: unknown, not a low count.
    const shallow = scratch();
    execFileSync('git', ['clone', '-q', '--depth', '2', `file://${repo}`, shallow]);
    execFileSync('git', ['-C', shallow, 'update-ref', 'refs/remotes/origin/master', 'HEAD']);
    execFileSync('git', ['-C', shallow, 'fetch', '-q', '--depth', '1', 'origin', shipped]);
    expect(await readSelfDrift({ repo: shallow, installed: () => ({ bin: null, version: '3.0.0', revision: shipped }), now: NOW })).toMatchObject({ behindCommits: 'unknown' });
  });

  it('a capability missing: non-zero exit, or exit 0 with generic help that lacks the proof', async () => {
    const probe: HelpProbe = async argv => argv[0] === 'recut' ? { code: 2, output: 'Unknown command: recut', timedOut: false }
      : argv[0] === 'leader' ? { code: 0, output: 'Phantom Leader: memo and veto', timedOut: false } : allLive(argv);
    const drift = await readSelfDrift({ git: tagsOnly, installed: installed('3.1.0'), probe, now: NOW });
    expect(drift.missingFeatures).toEqual(['recut-check', 'leader-replies']);
    expect(drift.liveFeatures).toHaveLength(5);
    expect(drift.line).toBe('1 release behind, 2 fleet features not live yet');
    expect(formatSelfDrift(drift)).toContain('  missing recut-check (phm recut check --help)');
    expect(formatSelfDrift(drift)).toContain('Next: update the installed CLI');
    expect(formatSelfDrift({ ...drift, behindReleases: 0 })).toContain('Next: these are merged but not released yet');
  });

  it('a --help timeout or a failed spawn is unknown, never missing', async () => {
    const probe: HelpProbe = async argv => argv[0] === 'decisions' ? { code: null, output: '', timedOut: true }
      : argv[0] === 'models' ? Promise.reject(new Error('spawn failed')) : allLive(argv);
    const drift = await readSelfDrift({ git: tagsOnly, installed: installed('3.2.0'), probe, now: NOW });
    expect(drift.unknownFeatures).toEqual(['decisions', 'model-check']);
    expect(drift.missingFeatures).toEqual([]);
    expect(drift.line).toBe('Up to date; 2 features unknown');
  });

  it('no build info and no clone: every fact is unknown and no CLI is run', async () => {
    const probe = vi.fn(allLive);
    const drift = await readSelfDrift({ git: () => null, installed: installed(null, null), now: NOW });
    expect(drift).toMatchObject({ installed: { version: 'unknown', revision: 'unknown' }, latestRelease: { tag: 'unknown', at: 'unknown' },
      behindReleases: 'unknown', behindCommits: 'unknown', oldestUnshippedMergeAt: 'unknown', liveFeatures: [], missingFeatures: [],
      line: 'releases behind unknown, 0 fleet features not live yet; 7 features unknown' });
    expect(probe).not.toHaveBeenCalled();
    expect(countBehind('3.1.0', [])).toBe('unknown');
    expect(countBehind('dev-build', [{ tag: 'v3.1.0' }])).toBe('unknown');
    expect(readBehindReleases({ git: () => null, installed: () => { throw new Error('not read without tags'); } })).toBe('unknown');
  });

  it('reads the installed version and build commit from the package on PATH, never running it', () => {
    const root = scratch(), pkg = join(root, 'lib', 'phantom'), bin = join(root, 'bin');
    mkdirSync(join(pkg, 'bin'), { recursive: true }); mkdirSync(join(pkg, 'dist')); mkdirSync(bin);
    writeFileSync(join(pkg, 'bin', 'ashlr'), 'not run'); symlinkSync(join(pkg, 'bin', 'ashlr'), join(bin, 'phm'));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@ashlr/phantom', version: '3.1.0' }));
    expect(readInstalledBuild(bin)).toEqual({ bin: join(bin, 'phm'), version: '3.1.0', revision: null });
    writeFileSync(join(pkg, 'dist', 'build-identity.json'), JSON.stringify({ schemaVersion: 1, packageVersion: '3.2.0', revision: null, dirty: null, provenance: 'unavailable' }));
    expect(readInstalledBuild(bin)).toEqual({ bin: join(bin, 'phm'), version: '3.2.0', revision: null });
    expect(readInstalledBuild(join(root, 'empty'))).toEqual({ bin: null, version: null, revision: null });
  });

  it('CLI: versioned JSON, the text report, help, and usage errors', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const read = vi.fn(async () => readSelfDrift({ git: tagsOnly, installed: installed('3.0.0'), probe: allLive, now: NOW }));
    expect(await cmdSelf(['drift', '--json', '--repo', '/x'], read)).toBe(0);
    expect(read).toHaveBeenCalledWith('/x');
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ schema: 'phantom.self-drift.v1', version: 1, behindReleases: 2 });
    expect(await cmdSelf(['drift'], read)).toBe(0);
    expect(String(write.mock.calls.at(-1)?.[0])).toContain('Running build: 2 releases behind, 0 fleet features not live yet');
    expect(await cmdSelf(['drift', '--help'], read)).toBe(0);
    for (const bad of [[], ['dirft'], ['drift', '--json', '--json'], ['drift', '--repo']]) expect(await cmdSelf(bad, read)).toBe(2);
    expect(err).toHaveBeenCalled();
  });
});

describe('release-due ranking', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const inputs = (behindReleases?: number | 'unknown') => [
    { repo: 'ashlrai/locus', latestTag: 'v0.9.1', taggedAt: daysAgo(3), mergedPrsSinceTag: 120 },
    { repo: 'ashlrai/phantom', latestTag: 'v3.2.0', taggedAt: daysAgo(9), mergedPrsSinceTag: 60, behindReleases },
  ];

  it('an installed build behind on releases lifts an overdue Phantom to next', () => {
    expect(releaseCadence(inputs(), now).next?.repo).toBe('ashlrai/locus');
    expect(releaseCadence(inputs('unknown'), now).next?.repo).toBe('ashlrai/locus');
    const boosted = releaseCadence(inputs(2), now);
    expect(boosted.next).toMatchObject({ repo: 'ashlrai/phantom', behindReleases: 2, suggestion: 'phantom: 60 PRs since v3.2.0 9 days ago; release due; installed build 2 releases behind' });
    expect(boosted.repos[0]).not.toHaveProperty('behindReleases');
  });

  it('getReleases feeds the boost from the Phantom clone tags and the installed manifest', () => {
    const root = scratch(), repo = join(root, 'phantom');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    mkdirSync(repo); git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('commit', '--allow-empty', '-qm', 'first'); git('tag', 'v3.0.0'); git('commit', '--allow-empty', '-qm', 'fix: one (#1)'); git('tag', 'v3.1.0');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD'); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
    const row = getReleases({ root, repos: ['phantom'], installed: installed('3.0.0') }).repos[0]!;
    expect(row).toMatchObject({ repo: 'ashlrai/phantom', behindReleases: 1 });
    expect(row.suggestion).toContain('installed build 1 release behind');
  });

  it('the line names only what is known', () => {
    expect(driftLine({ behindReleases: 0, missingFeatures: ['pulse'], unknownFeatures: [] })).toBe('0 releases behind, 1 fleet feature not live yet');
  });
});
