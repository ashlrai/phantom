import { afterEach, expect, it, vi } from 'vitest';
import { generateFleetRegistry } from '../scripts/gen-fleet-registry.mjs';
import { cmdFleet } from '../src/cli/fleet-entry.js';
import { cmdFleetPublicationEvidence } from '../src/cli/fleet-publication-evidence.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { readReleases, releaseRepo } from '../src/core/release/publication-evidence.js';
import { publicationEvidenceLine, publicationEvidenceSchema } from '../src/core/release/publication-evidence-shape.js';
import type { OpsRunner } from '../src/core/verse/ops-releases.js';

const now = Date.parse('2026-11-17T12:00:00Z');
const published = { tagName: 'v1.0', publishedAt: '2026-11-16T12:00:00Z', isDraft: false, isPrerelease: false };
const pr = { number: 12, mergedAt: '2026-11-17T00:00:00Z' };
function runner(releases: unknown = [published], prs: unknown = [], createdAt = '2026-11-16T12:00:00Z'): OpsRunner {
  return vi.fn(async (bin, args) => bin === 'gh' ? JSON.stringify(args[0] === 'release' ? releases : prs)
    : args.includes('symbolic-ref') ? 'origin/main' : args.includes('for-each-ref') ? `v1.0\t${createdAt}`
      : args.includes('rev-parse') ? 'false' : args.includes('rev-list') ? '3' : '## [Unreleased]\n- A change\n');
}
const report = (run = runner()) => readReleases({ repo: 'phantom', now, run });
afterEach(() => vi.restoreAllMocks());

it.each([
  ['2099-01-01T00:00:00Z', null, null],
  ['2026-11-17T12:00:00Z', 0, 3],
  ['2026-11-15T12:00:00Z', 2, 3],
] as const)('local tag age for %s is %s days', async (createdAt, ageDays, commitsSince) => {
  const row = (await report(runner([published], [], createdAt))).repos[0]!;
  expect(row.localTag).toEqual({ name: 'v1.0', ageDays, commitsSince });
  if (ageDays === null) expect(publicationEvidenceLine(row)).toContain('Local tag v1.0 (unknown days old)');
});

it.each([[[], 'none-merged-after', 0], [[pr], 'merged-after', 1], [null, 'unknown', null]] as const)('lag fixture %j => %s', async (prs, lag, count) => {
  const result = await report(runner([published], prs));
  expect(result.repos[0]).toMatchObject({ lag, mergedAfterPublication: count });
  expect(publicationEvidenceSchema.parse(result)).toEqual(result);
  expect(Object.keys(result)).toEqual(['schema', 'version', 'asOf', 'repos']);
  expect(result.schema).toBe('phantom.publication-evidence.v1');
  expect(publicationEvidenceLine(result.repos[0]!)).toContain(lag === 'merged-after' ? '1 PRs merged after publication' : lag === 'unknown' ? 'publication lag unknown' : 'no PRs merged after publication');
  expect(publicationEvidenceSchema.safeParse({ ...result, repos: [{ ...result.repos[0], lag: 'none-merged-after', mergedAfterPublication: null }] }).success).toBe(false);
});

it('never presents merged-after-publication as proof of contents or shipping', async () => {
  const row = (await report(runner([published], [pr]))).repos[0]!;
  expect(row.reason).toContain('not proof of what the artifacts contain');
  expect(JSON.stringify(row)).not.toMatch(/shipped|installed|behind|fresh/i);
});

it('separates drafts and prereleases from the stable publication baseline', async () => {
  const run = runner([{ ...published, tagName: 'v2', isDraft: true, publishedAt: '' }, { ...published, tagName: 'v3', isPrerelease: true }, published], [pr]);
  const row = (await report(run)).repos[0]!;
  expect(row).toMatchObject({ published: { tag: 'v1.0' }, drafts: [{ tag: 'v2', publishedAt: null }], prereleases: [{ tag: 'v3', prerelease: true }], lag: 'merged-after', next: 'review release' });
  expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['--base', 'main', 'merged:>2026-11-16T12:00:00.000Z']));
  expect(publicationEvidenceLine(row)).toContain('Draft: v2; Prerelease: v3');
});

it.each([[], [{ ...published, isDraft: true }], [{ ...published, isPrerelease: true }]].map(releases => ({ releases })))('no stable release stays unknown: %j', async ({ releases }) => {
  const row = (await report(runner(releases))).repos[0]!;
  expect(row).toMatchObject({ releasesKnown: true, published: null, lag: 'unknown', mergedAfterPublication: null });
  expect(publicationEvidenceLine(row)).toContain('No published stable release');
  expect(publicationEvidenceSchema.safeParse({ schema: 'phantom.publication-evidence.v1', version: 1, asOf: new Date(now).toISOString(), repos: [row] }).success).toBe(true);
});

it.each([null, {}, [{ ...published, publishedAt: 'bad' }], [{ ...published, publishedAt: '2099-01-01' }], Array(100).fill(published)].map(releases => ({ releases })))('refuses failed, malformed, future and capped release reads', async ({ releases }) => {
  expect((await report(runner(releases))).repos[0]).toMatchObject({ releasesKnown: false, drafts: null, prereleases: null, lag: 'unknown' });
});

it.each([[pr, pr], Array(1000).fill(pr), [{ ...pr, mergedAt: 'bad' }], [{ ...pr, mergedAt: published.publishedAt }], [{ ...pr, mergedAt: '2099-01-01T00:00:00Z' }]].map(prs => ({ prs })))('refuses incomplete, duplicate or invalid merged PR evidence', async ({ prs }) => {
  expect((await report(runner([published], prs))).repos[0]).toMatchObject({ lag: 'unknown', mergedAfterPublication: null });
});

it('keeps independent fields unknown and does not turn direct commits into nothing to release', async () => {
  expect((await report(async () => { throw new Error('private diagnostic'); })).repos[0]).toMatchObject({ localTag: { name: null, commitsSince: null }, lag: 'unknown' });
  expect((await report()).repos[0]).toMatchObject({ localTag: { commitsSince: 3 }, next: 'no new merged PRs' });
  const base = runner([published], [pr]);
  expect((await report((bin, args) => args.includes('show') ? Promise.resolve('## [Unreleased]\n') : base(bin, args))).repos[0]?.next).toBe('write changelog');
});

it('filters to the default branch and to enrolled repos before reading; rejects arbitrary paths', async () => {
  const run = runner(); expect((await readReleases({ repo: 'ashlrai/locus', now, run })).repos.map(r => r.repo)).toEqual(['locus']);
  expect(run).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['ashlrai/phantom']));
  expect(releaseRepo('ashlrai/phantom')).toBe('phantom'); expect(releaseRepo('../phantom')).toBeNull(); expect(releaseRepo('other')).toBeNull();
  await expect(readReleases({ repo: '../phantom', run })).rejects.toThrow('Unknown enrolled repository');
  const other = vi.fn(async (bin: string, args: readonly string[]) => bin === 'git' && args.includes('symbolic-ref') ? 'origin/trunk' : runner([published], [])(bin, args));
  await readReleases({ repo: 'phantom', now, run: other });
  expect(other).toHaveBeenCalledWith('gh', expect.arrayContaining(['--base', 'trunk']));
});

it('only issues read-only argv and bounds concurrency to two repos', async () => {
  let live = 0, peak = 0; const calls: string[][] = [];
  const base = runner([published], []);
  const run: OpsRunner = async (bin, args) => {
    calls.push([bin, ...args]); live++; peak = Math.max(peak, live);
    await new Promise(resolve => setTimeout(resolve, 2)); live--; return base(bin, args);
  };
  expect((await readReleases({ now, run })).repos).toHaveLength(7);
  expect(peak).toBeLessThanOrEqual(2);
  for (const [bin, ...args] of calls) {
    expect(['gh', 'git']).toContain(bin);
    if (bin === 'gh') expect(args.slice(0, 2).join(' ')).toMatch(/^(release|pr) list$/);
    else expect(['symbolic-ref', 'for-each-ref', 'rev-parse', 'rev-list', 'show']).toContain(args[2]);
    expect(args.join(' ')).not.toMatch(/create|tag -|push|workflow|auth|token|--web/);
  }
  // A runner asked for anything else is never reached.
  const spy = vi.fn(async () => 'x');
  await readReleases({ repo: 'phantom', now, run: spy });
  expect(spy.mock.calls.every(([bin, args]) => bin === 'git' ? (args as string[])[0] === '-C' : (args as string[])[1] === 'list')).toBe(true);
});

it('CLI prints the report or plain words and validates flags without reading', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}); const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = vi.fn(() => report());
  expect(await cmdFleetPublicationEvidence(['--repo', 'phantom', '--root', '/fixture', '--json'], read)).toBe(0);
  expect(read).toHaveBeenCalledWith({ repo: 'phantom', root: '/fixture' }); expect(JSON.parse(log.mock.calls[0]![0]).version).toBe(1);
  expect(await cmdFleetPublicationEvidence([], read)).toBe(0); expect(log.mock.calls.at(-1)![0]).toContain('phantom: no PRs merged after publication');
  for (const args of [['--repo'], ['--repo', 'bad'], ['--bogus'], ['--json', '--json'], ['--root'], ['--root', 'relative/dir'], ['--root', '/fixture\u0000'], ['--root', '/fixture\n'], ['--repo', 'phantom', '--repo', 'locus'], ['--root', '/a', '--root', '/b'], ['--repo', '--json']]) {
    expect(await cmdFleetPublicationEvidence(args, read)).toBe(2);
  }
  expect(await cmdFleetPublicationEvidence(['--help'], read)).toBe(0); expect(read).toHaveBeenCalledTimes(2);
  expect(err).toHaveBeenCalled();
});

it('CLI reports a safe error without raw diagnostics when the read fails', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {}); const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetPublicationEvidence([], async () => { throw new Error('/Users/someone/secret failed'); })).toBe(1);
  expect(err.mock.calls.flat().join(' ')).toBe('Publication evidence could not be read.');
});

it('is registered and reachable through the fleet dispatcher', async () => {
  expect(Object.keys(FLEET_SUBCOMMAND_LOADERS)).toContain('publication-evidence');
  const mod = await FLEET_SUBCOMMAND_LOADERS['publication-evidence']!();
  expect(typeof mod.cmdFleetPublicationEvidence).toBe('function');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleet(['publication-evidence', '--help'])).toBe(0);
  expect(log.mock.calls.flat().join('\n')).toContain('phm fleet publication-evidence');
  expect(await cmdFleet(['publication-evidence', '--bogus'])).toBe(2);
});

it('keeps the generated fleet registry in sync after preserving the verb', () => {
  expect(generateFleetRegistry(['--check'])).toBe(0);
});
