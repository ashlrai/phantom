import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdReleases } from '../src/cli/releases.js';
import { readReleases } from '../src/core/release/releases.js';
import { releaseRowLine, releasesSchema } from '../src/core/release/releases-shape.js';
import type { OpsRunner } from '../src/core/verse/ops-releases.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

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
] as const)('tag age for %s is %s days', async (createdAt, ageDays, commitsSinceTag) => {
  const run = runner([published], [], createdAt);
  const row = (await report(run)).repos[0]!;
  expect(row).toMatchObject({ latestTag: 'v1.0', ageDays, commitsSinceTag });
  if (ageDays === null) expect(releaseRowLine(row)).toContain('Local tag v1.0 (unknown days old)');
});
it.each([[[], 'fresh', 0], [[pr], 'behind', 1], [null, 'unknown', null]] as const)('freshness fixture %j => %s', async (prs, state, count) => {
  const result = await report(runner([published], prs));
  expect(result.repos[0]).toMatchObject({ freshness: state, mergedPrsSinceRelease: count });
  expect(releasesSchema.parse(result)).toEqual(result);
  expect(releaseRowLine(result.repos[0]!)).toContain(state === 'behind' ? 'behind 1 merged PRs' : state);
  expect(Object.keys(result)).toEqual(['schema', 'version', 'asOf', 'repos']); expect(result.version).toBe(1);
  expect(releasesSchema.safeParse({ ...result, repos: [{ ...result.repos[0], freshness: 'fresh', mergedPrsSinceRelease: null }] }).success).toBe(false);
});
it('separates drafts and prereleases from the stable publication baseline', async () => {
  const run = runner([{ ...published, tagName: 'v2', isDraft: true, publishedAt: '' }, { ...published, tagName: 'v3', isPrerelease: true }, published], [pr]);
  const row = (await report(run)).repos[0]!;
  expect(row).toMatchObject({ published: { tag: 'v1.0' }, drafts: [{ tag: 'v2', publishedAt: null }], freshness: 'behind', next: 'review release' });
  expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['--base', 'main', 'merged:>2026-11-16T12:00:00.000Z']));
});
it.each([[], [{ ...published, isDraft: true }], [{ ...published, isPrerelease: true }]].map(releases => ({ releases })))('no stable release stays unknown: %j', async ({ releases }) => {
  const row = (await report(runner(releases))).repos[0]!;
  expect(row).toMatchObject({ releasesKnown: true, published: null, freshness: 'unknown', mergedPrsSinceRelease: null });
  expect(releaseRowLine(row)).toContain('No published stable release');
});
it.each([null, {}, [{ ...published, publishedAt: 'bad' }], [{ ...published, publishedAt: '2099-01-01' }], Array(100).fill(published)].map(releases => ({ releases })))('refuses failed, malformed, future and capped release reads', async ({ releases }) => {
  expect((await report(runner(releases))).repos[0]).toMatchObject({ releasesKnown: false, drafts: null, freshness: 'unknown' });
});
it.each([[pr, pr], Array(1000).fill(pr), [{ ...pr, mergedAt: 'bad' }], [{ ...pr, mergedAt: published.publishedAt }]].map(prs => ({ prs })))('refuses incomplete or invalid merged PR evidence', async ({ prs }) => {
  expect((await report(runner([published], prs))).repos[0]?.freshness).toBe('unknown');
});
it('keeps independent fields unknown and does not turn direct commits into nothing to release', async () => {
  expect((await report(async () => { throw new Error('private diagnostic'); })).repos[0]).toMatchObject({ latestTag: null, commitsSinceTag: null, freshness: 'unknown' });
  expect((await report()).repos[0]).toMatchObject({ commitsSinceTag: 3, next: 'no new merged PRs' });
  const base = runner([published], [pr]);
  expect((await report((bin, args) => args.includes('show') ? Promise.resolve('## [Unreleased]\n') : base(bin, args))).repos[0]?.next).toBe('write changelog');
});
it('filters before reading and accepts full names; rejects arbitrary paths', async () => {
  const run = runner(); expect((await readReleases({ repo: 'ashlrai/locus', now, run })).repos.map(r => r.repo)).toEqual(['locus']);
  expect(run).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['ashlrai/phantom']));
  await expect(readReleases({ repo: '../phantom', run })).rejects.toThrow('Unknown enrolled repository');
});
it('CLI prints the report or plain words and validates flags without reading', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = vi.fn(() => report()); expect(await cmdReleases(['--repo', 'phantom', '--root', '/fixture', '--json'], read)).toBe(0);
  expect(read).toHaveBeenCalledWith({ repo: 'phantom', root: '/fixture' }); expect(JSON.parse(log.mock.calls[0]![0]).version).toBe(1);
  expect(await cmdReleases([], read)).toBe(0); expect(log.mock.calls.at(-1)![0]).toContain('phantom: fresh');
  for (const args of [['--repo'], ['--repo', 'bad'], ['--bogus'], ['--json', '--json'], ['--root']]) expect(await cmdReleases(args, read)).toBe(2);
  expect(await cmdReleases(['--help'], read)).toBe(0); expect(read).toHaveBeenCalledTimes(2);
});
it('API shares filtering and JSON; rejects mutation and reports read failure', async () => {
  const read = vi.fn(() => report()); const api = createFleetRunsApi({ readReleases: read, now: () => now });
  const call = async (query = '', method = 'GET') => {
    const req = Object.assign(new PassThrough(), { url: `/api/verse/fleet/runs/releases${query}` }) as IncomingMessage;
    let status = 0, body = ''; const res = { writeHead(code: number) { status = code; }, end(chunk: string) { body = chunk; } } as ServerResponse;
    await api({} as VerseApiContext, req, res, '/api/verse/fleet/runs/releases', method); return { status, body: JSON.parse(body) };
  };
  expect(await call('?repo=locus')).toEqual({ status: 200, body: await report() }); expect(read).toHaveBeenCalledWith({ repo: 'locus', now });
  expect((await call('?repo=bad')).status).toBe(400); expect((await call('?repo=locus&repo=phantom')).status).toBe(400);
  expect((await call('', 'POST')).status).toBe(405); read.mockRejectedValueOnce(new Error('private diagnostic')); expect((await call()).status).toBe(503);
  let finish!: (value: Awaited<ReturnType<typeof report>>) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const before = read.mock.calls.length, a = call('?repo=locus'), b = call('?repo=ashlrai/locus');
  await vi.waitFor(() => expect(read.mock.calls.length).toBe(before + 1)); finish(await report());
  expect((await Promise.all([a, b])).map(r => r.status)).toEqual([200, 200]);
});
