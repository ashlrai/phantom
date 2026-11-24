import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compactBriefLines, readCompactBrief, type CompactLeaderBrief } from '../src/core/fleet/leader-compact-brief.js';
import { groupHostFamilies } from '../src/core/fleet/host-families.js';
import * as backlog from '../src/core/release/backlog.js';
import * as gitLatency from '../src/core/fleet/git-merge-latency.js';

const now = Date.parse('2026-11-21T12:00:00Z'), at = new Date(now).toISOString();
const stamp = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const url = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
let dir: string;
const read = () => readCompactBrief(dir, now, async () => groupHostFamilies(null));
const ledger = (rows: object[]) => writeFile(join(dir, 'metrics/jobs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'brief-merges-815s-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stops.tsv'));
  vi.spyOn(backlog, 'readReleaseBacklog').mockResolvedValue({ schema: 'phantom.release-backlog.v1', checkedAt: at,
    counts: { ok: 0, due: 0, stale: 0, unknown: 0 }, repos: [] });
  vi.spyOn(gitLatency, 'readGitMergeLatency').mockResolvedValue(gitLatency.mergeLatencyFromGit([], [], now / 1000));
  await mkdir(join(dir, 'metrics'));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

// Original #8043 assertions: eventless outcomes, old observation stamps, five distinct
// merges ordered by actual merge time, repository/title/time fields and payload bound.
it('preserves the source merge assertions and retains the latest valid duplicate', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ state: 'MERGED', ts: stamp(48 * 60),
    mergedAt: stamp(i), url: url(i + 1), title: 'Better view' }));
  await ledger([...rows, rows[0]!, { ...rows[0], mergedAt: stamp(30), title: 'Older duplicate' },
    { ...rows[0], mergedAt: stamp(-1), title: 'Future duplicate' },
    { event: 'publish', ts: at, url: url(8) }]);
  const b = await read();
  expect(b.mergedPrs.map(pr => pr.number)).toEqual([1, 2, 3, 4, 5]);
  expect(b.mergedPrs[0]).toMatchObject({ repo: 'ashlrai/phantom', title: 'Better view', at });
  expect(b.headline).toBe('No measured supply-starved lane');
  expect(b.omitted).toBe(2);
  expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThan(8191);
  const { mergedPrs: _merges, ...old } = b;
  const stored: CompactLeaderBrief = old;
  expect(compactBriefLines(stored)).toEqual(compactBriefLines(b));
});

it('requires explicit merge evidence, canonical URLs and valid nonfuture times', async () => {
  const base = { state: 'MERGED', ts: at, url: url(1) };
  await ledger([
    { ...base, event: 'merged', title: '  Better\nview ' },
    { type: 'published', outcome: 'MERGED', timestamp: stamp(1), pr_url: url(2) },
    { kind: 'merged', time: stamp(2), prUrl: url(3) },
    { ...base, state: 'OPEN', event: 'launch', url: url(4) },
    { ...base, state: 'PUBLISHED', event: 'publish', url: url(5) },
    ...['https://example.invalid/ashlrai/phantom/pull/6', 'http://github.com/a/b/pull/6',
      'https://github.com.evil.invalid/a/b/pull/6', 'https://github.com/a/b/pull/6?x=1',
      'https://github.com/a/b/pull/6/extra', 'https://github.com/a/../pull/6',
      'https://github.com/-a/b/pull/6', 'https://github.com/a/b/pull/0',
      'https://github.com/a/b/pull/9007199254740993', 'https://github.com/a/b/issues/6']
      .map(url => ({ ...base, url })),
    { ...base, url: url(7), mergedAt: 'invalid' },
    { ...base, url: url(8), mergedAt: stamp(-1) },
    { ...base, url: url(9), ts: stamp(-1), mergedAt: stamp(1) },
    { ...base, url: url(10), ts: 'invalid' },
    { ...base, url: url(11), mergedAt: null },
  ]);
  const b = await read();
  expect(b.mergedPrs.map(pr => pr.number)).toEqual([1, 2, 3]);
  expect(b.mergedPrs[0]?.title).toBe(' Better view ');
  expect(b.sources.ledger?.state).toBe('healthy');
});

it('scrubs and bounds titles without converting unavailable evidence to healthy emptiness', async () => {
  expect(await read()).toMatchObject({ mergedPrs: [], sources: { ledger: { state: 'missing' } } });
  await ledger([]);
  expect(await read()).toMatchObject({ mergedPrs: [], sources: { ledger: { state: 'healthy' } } });
  await writeFile(join(dir, 'metrics/jobs.jsonl'), 'invalid JSON\n');
  expect(await read()).toMatchObject({ mergedPrs: [], sources: { ledger: { state: 'degraded' } } });
  await ledger([{ event: 'merged', ts: at, url: url(1), title: `token=synthetic_fixture_value ${'界'.repeat(200)}` }]);
  const b = await read();
  expect(b.mergedPrs[0]?.title.length).toBeLessThanOrEqual(80);
  expect(b.mergedPrs[0]?.title).not.toContain('synthetic_fixture_value');
});

it('fits the payload bound under row pressure and accounts for omitted rows', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ event: 'launch', ts: at,
    job: `family${String.fromCharCode(97 + i % 26, 97 + Math.floor(i / 26))}` }));
  await ledger([...rows, ...Array.from({ length: 7 }, (_, i) => ({ event: 'merged', ts: stamp(i),
    url: url(i + 1), title: '界'.repeat(200) }))]);
  const b = await read();
  expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThan(8191);
  expect(b.omitted).toBeGreaterThan(2);
  expect(b.omitted).toBe(100 - b.families.length + 7 - b.mergedPrs.length);
  expect(b.mergedPrs.map(pr => pr.number)).toEqual([1, 2, 3, 4, 5]);
});

it('can omit merge rows themselves when the remaining payload needs space', async () => {
  const host = groupHostFamilies(null);
  await ledger(Array.from({ length: 5 }, (_, i) => ({ event: 'merged', ts: stamp(i),
    url: url(i + 1), title: '界'.repeat(200) })));
  const baseline = await read();
  const stripped = { ...baseline, families: [], stopped: [], main: [], pools: [], lanes: [], attention: [],
    mergedPrs: [], hostLoad: { ...baseline.hostLoad, blame: '' } };
  host.blame = 'x'.repeat(8190 - Buffer.byteLength(JSON.stringify(stripped)) - 600);
  const b = await readCompactBrief(dir, now, async () => host);
  expect(b.mergedPrs.length).toBeLessThan(5);
  const count = (brief: typeof b) => [brief.families, brief.stopped, brief.main, brief.pools,
    brief.lanes, brief.attention, brief.mergedPrs].reduce((total, list) => total + list.length, 0);
  expect(b.omitted).toBe(baseline.omitted + count(baseline) - count(b));
  expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThan(8191);
});
