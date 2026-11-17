import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdReleases } from '../src/cli/releases.js';
import {
  gitReleaseReader, narrowReleases, readReleases, releasesHomeField, releasesText,
  type ReleaseReader, type RepoReleaseFacts,
} from '../src/core/release/status.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ok = <T>(value: T) => ({ state: 'ok' as const, value });
const unknown = (reason: string) => ({ state: 'unknown' as const, reason });
const TAG = ok({ name: 'v1.2.0', createdAt: '2026-11-07T08:00:00.000Z' });
const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n- A fixture feature\n\n## [1.2.0] - 2026-11-07\n- Old entry\n';
const facts = (patch: Partial<RepoReleaseFacts> = {}): RepoReleaseFacts => ({
  defaultBranch: ok('main'), latestTag: TAG, subjectsSinceTag: ok([]), changelog: ok(CHANGELOG), changelogChangedSinceTag: ok(true), ...patch,
});
const SHIPPED = ['feat: add a fixture (#12)', 'fix: repair a fixture (#13)', 'docs: direct commit'];
const MISSING = 'No local checkout of ashlr-md was found.';
/** One repo per acceptance case, in the enrolled order. */
const FIXTURES: Record<string, RepoReleaseFacts> = {
  'phantom': facts(),
  'phantom-secrets': facts({ subjectsSinceTag: ok(SHIPPED) }),
  'locus': facts({ subjectsSinceTag: ok(SHIPPED), changelog: ok('# Changelog\n\n## [1.2.0]\n- Old entry\n') }),
  'lexicon': facts({ subjectsSinceTag: ok(SHIPPED), changelogChangedSinceTag: ok(false) }),
  'ashlr-plugin': facts({ latestTag: ok(null), subjectsSinceTag: ok(['first commit', 'Merge pull request #4 from a/b']), changelogChangedSinceTag: ok(null) }),
  'ashlr-stack': facts({ latestTag: ok(null), subjectsSinceTag: ok(['first commit']), changelog: ok(null), changelogChangedSinceTag: ok(null) }),
  'ashlr-md': { defaultBranch: unknown(MISSING), latestTag: unknown(MISSING), subjectsSinceTag: unknown(MISSING), changelog: unknown(MISSING), changelogChangedSinceTag: unknown(MISSING) },
};
const fixtureReader: ReleaseReader = async repo => FIXTURES[repo]!;
const row = async (repo: string) => (await readReleases({ now: NOW, read: fixtureReader })).repos.find(r => r.repo === repo)!;

describe('phm releases from fixtures', () => {
  it('up to date: no commits since the tag means nothing to release', async () => {
    expect(await row('phantom')).toEqual({
      repo: 'phantom', defaultBranch: ok('main'), latestTag: ok({ name: 'v1.2.0', ageDays: 10 }), commitsSinceTag: ok(0), mergedPrsSinceTag: ok(0),
      changelog: ok('covers'), next: 'nothing to release', why: 'No commits since v1.2.0.',
    });
  });
  it('unreleased with a changelog: ready to open a release PR', async () => {
    expect(await row('phantom-secrets')).toMatchObject({ commitsSinceTag: ok(3), mergedPrsSinceTag: ok(2), changelog: ok('covers'), next: 'ready: open release PR',
      why: '3 commits (2 PRs) since v1.2.0; the Unreleased section covers them.' });
  });
  it('unreleased without a changelog: write changelog, with the reason', async () => {
    expect(await row('locus')).toMatchObject({ changelog: ok('no-unreleased-section'), next: 'write changelog', why: '3 commits (2 PRs) since v1.2.0, but CHANGELOG.md has no Unreleased section at the top.' });
    expect(await row('lexicon')).toMatchObject({ changelog: ok('not-updated-since-tag'), next: 'write changelog' });
    expect(await row('ashlr-stack')).toMatchObject({ latestTag: ok(null), changelog: ok('no-file'), next: 'write changelog', why: '1 commit (0 PRs) and no tags yet, but there is no CHANGELOG.md.' });
    const empty = await readReleases({ now: NOW, repos: ['phantom'], read: async () => facts({ subjectsSinceTag: ok(SHIPPED), changelog: ok('## [Unreleased]\n\n### Added\n\n## [1.2.0]\n- Old\n') }) });
    expect(empty.repos[0]).toMatchObject({ changelog: ok('unreleased-empty'), next: 'write changelog' });
  });
  it('no tags yet: everything on the default branch counts, merge commits included', async () => {
    expect(await row('ashlr-plugin')).toMatchObject({ latestTag: ok(null), commitsSinceTag: ok(2), mergedPrsSinceTag: ok(1), changelog: ok('covers'), next: 'ready: open release PR',
      why: '2 commits (1 PR) and no tags yet; the Unreleased section covers them.' });
  });
  it('source missing: every field is unknown with the reason, never zero', async () => {
    expect(await row('ashlr-md')).toEqual({
      repo: 'ashlr-md', defaultBranch: unknown(MISSING), latestTag: unknown(MISSING), commitsSinceTag: unknown(MISSING), mergedPrsSinceTag: unknown(MISSING),
      changelog: unknown(MISSING), next: 'unknown', why: MISSING,
    });
    const thrown = await readReleases({ now: NOW, repos: ['locus'], read: async () => { throw new Error('boom'); } });
    expect(thrown.repos[0]).toMatchObject({ next: 'unknown', why: 'The release reader failed for locus.', latestTag: unknown('The release reader failed for locus.') });
    const noChangelog = await readReleases({ now: NOW, repos: ['locus'], read: async () => facts({ subjectsSinceTag: ok(SHIPPED), changelog: unknown('CHANGELOG.md could not be read.') }) });
    expect(noChangelog.repos[0]).toMatchObject({ next: 'unknown', why: '3 commits (2 PRs) since v1.2.0; the changelog is unknown: CHANGELOG.md could not be read.' });
  });
  it('stable JSON: fixed key and repo order, a summary Home can reuse, and the same bytes every time', async () => {
    const report = await readReleases({ now: NOW, read: fixtureReader });
    expect(JSON.stringify(await readReleases({ now: NOW, read: fixtureReader }))).toBe(JSON.stringify(report));
    expect(Object.keys(report)).toEqual(['schema', 'asOf', 'repos', 'summary']);
    expect(Object.keys(report.repos[0]!)).toEqual(['repo', 'defaultBranch', 'latestTag', 'commitsSinceTag', 'mergedPrsSinceTag', 'changelog', 'next', 'why']);
    expect(report.repos.map(r => [r.repo, r.next])).toEqual([
      ['phantom', 'nothing to release'], ['phantom-secrets', 'ready: open release PR'], ['locus', 'write changelog'], ['lexicon', 'write changelog'],
      ['ashlr-plugin', 'ready: open release PR'], ['ashlr-stack', 'write changelog'], ['ashlr-md', 'unknown'],
    ]);
    expect(report.summary).toEqual({
      headline: 'Ready to release: phantom-secrets, ashlr-plugin. Write a changelog first: locus, lexicon, ashlr-stack. Unknown: ashlr-md.',
      ready: ['phantom-secrets', 'ashlr-plugin'], writeChangelog: ['locus', 'lexicon', 'ashlr-stack'], nothingToRelease: ['phantom'], unknown: ['ashlr-md'],
    });
    expect(releasesHomeField(report)).toEqual(ok(report.summary));
    expect(releasesHomeField(null)).toEqual(unknown('The release report could not be read.'));
    expect(narrowReleases(JSON.parse(JSON.stringify(report)))).toEqual(report);
    expect(narrowReleases({ ...report, schema: 'other' })).toBeNull();
    expect(releasesText(report)[1]).toBe('  phantom: nothing to release. No commits since v1.2.0. Tag v1.2.0 (10 days old); 0 commits, 0 PRs since; changelog covers.');
    expect(releasesText(report).at(-1)).toBe(`  ashlr-md: unknown. ${MISSING} Tag unknown; unknown commits, unknown PRs since; changelog unknown.`);
    const quiet = await readReleases({ now: NOW, repos: ['phantom'], read: async () => facts() });
    expect(quiet.summary.headline).toBe('Nothing to release.');
  });
});

describe('the local Git reader', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
  it('reads the tag, commits, PRs and changelog on origin/HEAD, and says why when it cannot', async () => {
    root = mkdtempSync(join(tmpdir(), 'releases-'));
    const path = join(root, 'phantom');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: '2026-11-07T08:00:00Z', GIT_AUTHOR_DATE: '2026-11-07T08:00:00Z' } });
    execFileSync('git', ['init', '-q', '-b', 'main', path]);
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'tag.gpgSign', 'false'); git('config', 'commit.gpgSign', 'false');
    writeFileSync(join(path, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n- First\n');
    git('add', '.'); git('commit', '-qm', 'chore: release 1.0.0'); git('tag', 'v1.0.0');
    git('commit', '--allow-empty', '-qm', 'feat: a fixture (#7)');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    const read = gitReleaseReader(root);
    expect(await read('phantom')).toEqual({
      defaultBranch: ok('main'), latestTag: ok({ name: 'v1.0.0', createdAt: '2026-11-07T08:00:00.000Z' }), subjectsSinceTag: ok(['feat: a fixture (#7)']),
      changelog: ok('# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n- First\n'), changelogChangedSinceTag: ok(false),
    });
    expect((await readReleases({ root, repos: ['phantom'], now: NOW })).repos[0]).toMatchObject({ next: 'write changelog', changelog: ok('unreleased-empty') });
    writeFileSync(join(path, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- A fixture\n\n## [1.0.0]\n- First\n');
    git('commit', '-qam', 'docs: changelog (#8)'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect((await readReleases({ root, repos: ['phantom'], now: NOW })).repos[0]).toMatchObject({ commitsSinceTag: ok(2), mergedPrsSinceTag: ok(2), next: 'ready: open release PR' });
    expect((await read('locus')).latestTag).toEqual(unknown('No local checkout of locus was found.'));
    git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    expect((await read('phantom')).subjectsSinceTag).toEqual(unknown('origin/HEAD is not set, so the default branch is unknown.'));
  });
});

describe('phm releases CLI and API', () => {
  const report = () => readReleases({ now: NOW, read: fixtureReader });
  it('prints JSON or plain lines, passes --root through and rejects unknown flags', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const read = vi.fn(report);
      expect(await cmdReleases(['--json', '--root', '/fixture/root'], read)).toBe(0);
      expect(read).toHaveBeenCalledWith({ root: '/fixture/root' });
      expect(JSON.parse(String(log.mock.calls[0]![0])).schema).toBe('phantom.releases.v1');
      expect(await cmdReleases([], read)).toBe(0);
      expect(String(log.mock.calls[1]![0]).split('\n')[0]).toMatch(/^Ready to release: /);
      expect(await cmdReleases(['--bogus'], read)).toBe(2);
      expect(await cmdReleases(['--root'], read)).toBe(2);
      expect(await cmdReleases(['--help'], read)).toBe(0);
      expect(read).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); error.mockRestore(); }
  });
  it('serves the same report at GET /api/verse/fleet/runs/releases', async () => {
    const api = createFleetRunsApi({ readReleases: report, runsDir: join(tmpdir(), 'releases-api-unused') });
    const call = async (method: string) => {
      const req = new PassThrough() as IncomingMessage & PassThrough;
      Object.assign(req, { method, url: '/api/verse/fleet/runs/releases', headers: {} }); req.end();
      let status = 0, body = '';
      const res = { writeHead(code: number) { status = code; return this; }, end(chunk?: string) { body = chunk ?? ''; return this; } } as unknown as ServerResponse;
      await api({ token: 'fixture-token', allowDispatch: false } as VerseApiContext, req, res, '/api/verse/fleet/runs/releases', method);
      return { status, body: body ? JSON.parse(body) as unknown : null };
    };
    expect(await call('GET')).toEqual({ status: 200, body: JSON.parse(JSON.stringify(await report())) });
    expect((await call('POST')).status).toBe(405);
  });
});
