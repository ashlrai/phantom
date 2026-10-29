import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

import {
  collectEcosystemChangelog, parseEcosystemChangelog, readPublicChangelogApi,
  type EcosystemChangelog,
} from '../src/core/ecosystem/changelog.js';
import { ECOSYSTEM_CHANGELOG_REPOSITORIES, ECOSYSTEM_TIER_RANK, type EcosystemChangelogRepository } from '../src/core/ecosystem/map.js';
import { compareReposByStrategicFocus } from '../src/core/ecosystem/focus.js';
import { ECOSYSTEM_CHANGELOG_LINKS } from '../src/core/ecosystem/changelog-links.js';

// Three fixture repositories intentionally supplied out of strategic order.
const repos: EcosystemChangelogRepository[] = [
  { repository: 'fixture/alpha', directory: 'alpha', tier: 'supporting' },
  { repository: 'fixture/zeta', directory: 'zeta', tier: 'core-fleet' },
  { repository: 'fixture/middle', directory: 'middle', tier: 'force-multiplier' },
];
const release = (id = 1, extra: Record<string, unknown> = {}) => ({
  id, tag_name: `v1.0.${id}`, name: `Release ${id}`, body: 'Published notes',
  published_at: '2026-10-24T12:00:00Z', draft: false, prerelease: false, ...extra,
});
const pr = (number = 1, extra: Record<string, unknown> = {}) => ({
  number, title: `Change ${number}`, body: '', merged_at: '2026-10-25T12:00:00Z', ...extra,
});
const endpoint = (repo: string, source: 'releases' | 'pulls', page = 1) =>
  `repos/${repo}/${source}?${source === 'pulls' ? 'state=closed&sort=updated&direction=desc&' : ''}per_page=100&page=${page}`;
let root: string;
let responses: Map<string, unknown>;
let requests: string[];
async function github(path: string): Promise<unknown> {
  requests.push(path);
  if (!responses.has(path)) throw new Error('Unexpected fixture endpoint');
  const response = responses.get(path);
  if (response instanceof Error) throw response;
  return response;
}
const collect = (extra: Partial<Parameters<typeof collectEcosystemChangelog>[0]> = {}) =>
  collectEcosystemChangelog({ root, repositories: repos, github, manualLinks: [], ...extra });
const changes = (report: EcosystemChangelog) => report.repositories.flatMap((repo) => repo.changes);
const status = (report: EcosystemChangelog, source: string, repository = 'fixture/zeta') =>
  report.repositories.find((repo) => repo.repository === repository)!.sources.find((item) => item.source === source);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ecosystem-changelog-'));
  responses = new Map();
  requests = [];
  mocks.execFile.mockReset();
  for (const repo of repos) {
    await mkdir(join(root, repo.directory));
    await writeFile(join(root, repo.directory, 'CHANGELOG.md'), '# Changes\n\n## [1.0.0] - 2026-10-24\n\n### Added\n- Useful change (#1).\n');
    responses.set(`repos/${repo.repository}`, { private: false, full_name: repo.repository });
    responses.set(endpoint(repo.repository, 'releases'), []);
    responses.set(endpoint(repo.repository, 'pulls'), []);
  }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('ecosystem changelog collector', () => {
  it('collects three local repos, releases and merged PRs with symmetric cross-repo evidence', async () => {
    responses.set(endpoint('fixture/zeta', 'releases'), [release(1, { body: 'Ships #1' }), release(2, { draft: true })]);
    responses.set(endpoint('fixture/zeta', 'pulls'), [pr(2, { merged_at: null }), pr(1, { body: 'Companion: fixture/middle#7 and https://github.com/fixture/middle/pull/7.' })]);
    responses.set(endpoint('fixture/middle', 'pulls'), [pr(7)]);
    responses.set(endpoint('fixture/alpha', 'pulls'), [pr(9)]);
    const report = await collect({ manualLinks: [{ from: 'fixture/middle#7', to: 'https://github.com/fixture/alpha/pull/9' }] });
    expect(report.complete).toBe(true);
    expect(report.repositories.map(({ repository, tier }) => [repository, tier])).toEqual([
      ['fixture/zeta', 'core-fleet'], ['fixture/middle', 'force-multiplier'], ['fixture/alpha', 'supporting'],
    ]);
    expect(changes(report)).toHaveLength(7);
    const zeta = report.repositories[0].changes;
    expect(zeta.map(({ source }) => source)).toEqual(['pull-request', 'release', 'changelog']);
    expect(zeta.every((entry) => entry.crossRepo)).toBe(true);
    expect(zeta[0].relatedPullRequests).toEqual(['fixture/middle#7']);
    expect(changes(report).find((entry) => entry.number === 7)?.relatedPullRequests).toEqual(['fixture/alpha#9', 'fixture/zeta#1']);
    expect(changes(report).find((entry) => entry.number === 9)?.relatedPullRequests).toEqual(['fixture/middle#7']);
    expect(changes(report).some((entry) => entry.number === 2)).toBe(false);
    expect(zeta.find((entry) => entry.source === 'changelog')).toMatchObject({
      version: '1.0.0', date: '2026-10-24T00:00:00.000Z', body: '### Added\n- Useful change (#1).',
    });
  });

  it('produces byte-identical JSON despite repo and API ordering and duplicate records', async () => {
    const releases = [release(12), release(3), release(12)];
    const pulls = [pr(9), pr(2)];
    responses.set(endpoint('fixture/zeta', 'releases'), releases);
    responses.set(endpoint('fixture/zeta', 'pulls'), pulls);
    const first = JSON.stringify(await collect());
    releases.reverse();
    pulls.reverse();
    const second = JSON.stringify(await collect({ repositories: [...repos].reverse() }));
    expect(second).toBe(first);
  });

  it('uses the seven-repo map by default and the shared tier priority', async () => {
    expect(ECOSYSTEM_CHANGELOG_REPOSITORIES.map((repo) => repo.repository)).toEqual([
      'ashlrai/phantom', 'ashlrai/phantom-secrets', 'ashlrai/locus', 'ashlrai/lexicon',
      'ashlrai/ashlr-md', 'ashlrai/ashlr-stack', 'ashlrai/ashlr-plugin',
    ]);
    expect(Object.keys(ECOSYSTEM_TIER_RANK).sort((a, b) => ECOSYSTEM_TIER_RANK[a as keyof typeof ECOSYSTEM_TIER_RANK] - ECOSYSTEM_TIER_RANK[b as keyof typeof ECOSYSTEM_TIER_RANK])).toEqual([
      'core-fleet', 'force-multiplier', 'inventory', 'supporting',
    ]);
    expect(compareReposByStrategicFocus('locus', 'ashlr-auth')).toBeLessThan(0);
    const api = vi.fn(async (path: string) => path.includes('?') ? [] : { private: false, full_name: path.slice(6) });
    for (const repo of ECOSYSTEM_CHANGELOG_REPOSITORIES) {
      await mkdir(join(root, repo.directory));
      await writeFile(join(root, repo.directory, 'CHANGELOG.md'), '## [1.0.0]\n- Initial version');
    }
    const report = await collectEcosystemChangelog({ root, github: api });
    expect(report.complete).toBe(true);
    expect(changes(report)).toHaveLength(7);
    expect(api).toHaveBeenCalledTimes(21);
    expect(ECOSYSTEM_CHANGELOG_LINKS).toEqual([]);
  });

  it('paginates both APIs and counts unmerged PRs and drafts toward page length', async () => {
    responses.set(endpoint('fixture/zeta', 'releases'), Array.from({ length: 100 }, (_, id) => release(id + 1, { draft: true })));
    responses.set(endpoint('fixture/zeta', 'releases', 2), [release(101)]);
    responses.set(endpoint('fixture/zeta', 'pulls'), Array.from({ length: 100 }, (_, id) => pr(id + 1, { merged_at: null })));
    responses.set(endpoint('fixture/zeta', 'pulls', 2), [pr(101)]);
    const report = await collect();
    expect(report.complete).toBe(true);
    expect(requests).toContain(endpoint('fixture/zeta', 'releases', 2));
    expect(requests).toContain(endpoint('fixture/zeta', 'pulls', 2));
    expect(report.repositories[0].changes).toHaveLength(3);
  });

  it('marks capped pagination incomplete and retains the bounded evidence', async () => {
    responses.set(endpoint('fixture/zeta', 'pulls'), Array.from({ length: 100 }, (_, i) => pr(i + 1)));
    const report = await collect({ maxPages: 1 });
    expect(report.complete).toBe(false);
    expect(status(report, 'pull-request')).toEqual({ source: 'pull-request', status: 'truncated', reason: 'page-limit' });
    expect(report.repositories[0].changes).toHaveLength(101);
    expect(requests).not.toContain(endpoint('fixture/zeta', 'pulls', 2));
  });

  it('reports missing local files without hiding valid release evidence', async () => {
    await rm(join(root, 'zeta', 'CHANGELOG.md'));
    responses.set(endpoint('fixture/zeta', 'releases'), [release()]);
    const report = await collect();
    expect(report.complete).toBe(false);
    expect(status(report, 'changelog')).toMatchObject({ status: 'missing' });
    expect(report.repositories[0].changes).toHaveLength(1);
  });

  it('does not admit content from private, redirected, or unverified repositories', async () => {
    responses.set('repos/fixture/zeta', { private: true, full_name: 'fixture/zeta' });
    responses.set('repos/fixture/middle', { private: false, full_name: 'fixture/other' });
    responses.set('repos/fixture/alpha', new Error('Sensitive fixture diagnostic'));
    const report = await collect();
    expect(report.complete).toBe(false);
    expect(changes(report)).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(status(report, 'release')?.reason).toBe('not-public');
    expect(JSON.stringify(report)).not.toContain('Sensitive');
  });

  it('discards an interrupted source and sanitizes its error while retaining other sources', async () => {
    responses.set(endpoint('fixture/zeta', 'pulls'), Array.from({ length: 100 }, (_, i) => pr(i + 1)));
    responses.set(endpoint('fixture/zeta', 'pulls', 2), new Error('credential-shaped fixture diagnostic'));
    responses.set(endpoint('fixture/zeta', 'releases'), [release()]);
    const report = await collect();
    expect(report.complete).toBe(false);
    expect(status(report, 'pull-request')).toMatchObject({ status: 'error', reason: 'unavailable' });
    expect(report.repositories[0].changes.map((item) => item.source)).toEqual(['release', 'changelog']);
    expect(JSON.stringify(report)).not.toContain('credential-shaped');
  });

  it.each([
    { message: 'error response' },
    [{ number: 1, title: 'No merged_at field' }],
    [pr(1, { merged_at: 'yesterday' })],
    [pr(1, { merged_at: '2026-02-30T12:00:00Z' })],
    [pr(1), pr(1, { title: 'Conflicting duplicate' })],
  ])('reports malformed PR data instead of a successful empty history: %j', async (response) => {
    responses.set(endpoint('fixture/zeta', 'pulls'), response);
    const report = await collect();
    expect(report.complete).toBe(false);
    expect(status(report, 'pull-request')).toMatchObject({ status: 'error', reason: 'invalid-response' });
  });

  it('ignores non-roster refs, issue URLs, lookalike hosts and local-only PR refs', async () => {
    responses.set(endpoint('fixture/zeta', 'pulls'), [pr(1, { body: [
      'fixture/zeta#3 #4 outsider/project#8',
      'https://example.com/fixture/middle#7',
      'https://github.com.evil.test/fixture/middle/pull/7',
      'https://github.com/fixture/middle/issues/7',
    ].join('\n') })]);
    const report = await collect();
    expect(changes(report).every((entry) => !entry.crossRepo)).toBe(true);
  });

  it('rejects impossible release dates and preserves valid timezone offsets', async () => {
    responses.set(endpoint('fixture/zeta', 'releases'), [release(1, { published_at: '2026-02-30T12:00:00Z' })]);
    responses.set(endpoint('fixture/middle', 'releases'), [release(1, { published_at: '2026-10-24T23:00:00-04:00' })]);
    const report = await collect();
    expect(status(report, 'release')).toMatchObject({ status: 'error', reason: 'invalid-response' });
    expect(report.repositories[1].changes[0].date).toBe('2026-10-25T03:00:00.000Z');
  });

  it('accepts case-insensitive PR references and a target outside the fetched pages', async () => {
    responses.set(endpoint('fixture/zeta', 'pulls'), [pr(1, { title: 'Uses FIXTURE/MIDDLE#777', body: 'https://github.com/fixture/middle/pull/777#issuecomment-123' })]);
    const report = await collect();
    expect(report.repositories[0].changes[0].relatedPullRequests).toEqual(['fixture/middle#777']);
  });

  it.each([
    { from: 'fixture/zeta#1', to: 'fixture/zeta#2' },
    { from: 'fixture/zeta#1', to: 'outsider/project#2' },
    { from: 'fixture/zeta#1', to: 'https://other.test/fixture/middle/pull/2' },
    { from: 'fixture/zeta#0', to: 'fixture/middle#2' },
  ])('rejects invalid manual links before any API calls: %j', async (link) => {
    await expect(collect({ manualLinks: [link] })).rejects.toThrow('Invalid manual cross-repo link');
    expect(requests).toEqual([]);
  });

  it.each([0, -1, 101, 1.5])('rejects an invalid page bound %s', async (maxPages) => {
    await expect(collect({ maxPages })).rejects.toThrow('Invalid ecosystem changelog configuration');
    expect(requests).toEqual([]);
  });

  it('rejects path traversal and duplicate repository identities before any reads', async () => {
    await expect(collect({ repositories: [{ ...repos[0], directory: '../alpha' }] })).rejects.toThrow('configuration');
    await expect(collect({ repositories: [repos[0], { ...repos[0], repository: 'FIXTURE/ALPHA' }] })).rejects.toThrow('configuration');
    await expect(collect({ repositories: [{ ...repos[0], repository: 'fixture/alpha?secret' }] })).rejects.toThrow('configuration');
    expect(requests).toEqual([]);
  });
});

describe('changelog parsing', () => {
  it('preserves fenced headings, recognizes version formats, normalizes dates and typography', () => {
    const markdown = [
      '# History', '## [Unreleased]', '- Pending', '## [1.2.0](https://example.com/tag) - 2026-10-24',
      '### Added', '- More \u2014 useful', '```md', '## [9.9.9]', '```',
      '## v1.1.0 (2026-10-20)', '- Previous', '## [1.0.0-beta.1+build]', '- Preview',
    ].join('\r\n');
    const entries = parseEcosystemChangelog('fixture/zeta', markdown);
    expect(entries.map((item) => item.version)).toEqual(['Unreleased', '1.2.0', 'v1.1.0', '1.0.0-beta.1+build']);
    expect(entries[0]).toMatchObject({ date: null, unreleased: true });
    expect(entries[1].date).toBe('2026-10-24T00:00:00.000Z');
    expect(entries[1].body).toContain('## [9.9.9]');
    expect(entries[1].body).toContain('More  -  useful');
    expect(JSON.stringify(entries)).not.toContain('\u2014');
    expect(entries[3].date).toBeNull();
  });

  it('rejects impossible calendar dates and conflicting duplicate versions', () => {
    expect(() => parseEcosystemChangelog('fixture/zeta', '## [1.0.0] - 2026-02-30\n- Bad date')).toThrow();
    expect(() => parseEcosystemChangelog('fixture/zeta', '## [1.0.0]\n- One\n## [1.0.0]\n- Two')).toThrow();
  });

  it('recognizes versioned unreleased headings used by Phantom', () => {
    const entries = parseEcosystemChangelog('fixture/zeta', '## [3.29.15] \u2014 Unreleased\n- Pending\n## [3.29.14] - Unreleased\n- Earlier pending');
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.unreleased && entry.date === null)).toBe(true);
  });

  it('reports an unrecognized nonempty changelog instead of claiming no changes', async () => {
    await writeFile(join(root, 'zeta', 'CHANGELOG.md'), '# Different format\n## October 2026\n- Change');
    const report = await collect();
    expect(status(report, 'changelog')).toMatchObject({ status: 'error', reason: 'invalid-response' });
  });
});

describe('public gh API transport', () => {
  it('executes a bounded GET on github.com using argv without a shell or new credentials', async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '[{"id":1}]'));
    await expect(readPublicChangelogApi(endpoint('fixture/zeta', 'releases'))).resolves.toEqual([{ id: 1 }]);
    expect(mocks.execFile).toHaveBeenCalledWith('gh', [
      'api', '--hostname', 'github.com', '--method', 'GET', endpoint('fixture/zeta', 'releases'),
    ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, expect.any(Function));
  });

  it('never exposes subprocess diagnostics or malformed response bytes', async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error('sensitive fixture'), 'sensitive stdout'));
    await expect(readPublicChangelogApi('repos/fixture/zeta')).rejects.toThrow('Public GitHub source unavailable');
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, 'sensitive malformed output'));
    try { await readPublicChangelogApi('repos/fixture/zeta'); } catch (error) {
      expect(String(error)).not.toContain('sensitive');
    }
  });

  it.each(['https://evil.test/api', 'repos/{owner}/{repo}', 'repos/fixture/zeta/actions', 'repos/fixture/zeta?token=bad', 'repos/fixture/zeta/releases?per_page=100&page=1;id'])(
    'rejects unsupported endpoint %s before spawning', async (path) => {
      await expect(readPublicChangelogApi(path)).rejects.toThrow('Unsupported changelog endpoint');
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );
});
