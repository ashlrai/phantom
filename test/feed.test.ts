import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildFeed, defaultFeedReaders, FEED_KINDS, parseFeedQuery, readFeed, type FeedInputs, type FeedItem, type FeedReaders } from '../src/core/feed.js';
import { cmdFeed, renderFeed } from '../src/cli/feed.js';
import { worklog } from '../src/core/fleet/worklog.js';
import { writeReleaseNotices } from '../src/core/fleet/release-live-notice.js';
import { handleApi } from '../src/core/web/api.js';
import type { AshlrConfig } from '../src/core/types.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const local = (stamp: string) => new Date(stamp).toISOString();
let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'feed-'));
  for (const dir of ['metrics', 'leader', 'guardian']) await mkdir(join(runsDir, dir));
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  // Dispatch event lines carry local wall-clock times; pin the zone so the order is the same everywhere.
  vi.stubEnv('TZ', 'UTC');
  vi.stubEnv('PHANTOM_PLAN_LOG', join(runsDir, 'leader', 'PLAN-LOG.md'));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(runsDir, { recursive: true, force: true }); });

const jsonl = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const LEDGER = jsonl([
  { event: 'launch', job: 'RQ-MERGE', repo: 'phantom', lane: 'claude', title: 'Add the feed', ts: '2026-11-17T10:00:00Z' },
  { event: 'publish', job: 'RQ-MERGE', url: 'https://github.com/ashlrai/phantom/pull/123', ts: '2026-11-17T10:30:00Z' },
  { event: 'outcome', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/123', ts: '2026-11-17T11:00:00Z' },
  { event: 'launch', job: 'RQ-EMPTY', repo: 'phantom', ts: '2026-11-17T11:05:00Z' },
  { event: 'finish', job: 'RQ-EMPTY', empty: true, exit_code: 0, ts: '2026-11-17T11:10:00Z' },
  { event: 'finish', job: 'RQ-FAIL', repo: 'locus', exit_code: 2, ts: '2026-11-17T11:20:00Z' },
  { event: 'outcome', job: 'ghp_' + 'x'.repeat(36), state: 'MERGED', ts: '2026-11-17T11:21:00Z' },
]);
// Per-tick noise around three identical lane-hold lines and one incident.
const EVENTS = [
  ...['07:00', '07:01', '07:02'].flatMap(t => [`2026-11-17 ${t}:00 EMPTY_SIGNAL claude empty=3`, `2026-11-17 ${t}:01 LOADGATE warn (non-tripping): worktrees 41 > 40`]),
  ...['07:03', '07:04', '07:05'].map(t => `2026-11-17 ${t}:00 LANE_HOLD codex credits exhausted (limit); supervisor clears held in slots.`),
  '2026-11-17 07:06:00 INCIDENT disk guard paused launches',
  '2026-11-17 07:07:00 LOADGATE warn (non-tripping): worktrees 42 > 40',
].join('\n') + '\n';

async function fixture() {
  await writeFile(join(runsDir, 'metrics', 'jobs.jsonl'), LEDGER + '{malformed}\n');
  await writeFile(join(runsDir, 'dispatch-events.log'), EVENTS);
  writeReleaseNotices([{ repo: 'ashlrai/phantom', tag: 'v3.30.36', publishedAt: '2026-11-17T12:25:00Z',
    url: 'https://github.com/ashlrai/phantom/releases/tag/v3.30.36', draft: false, prerelease: false }], runsDir, new Date('2026-11-17T12:30:00Z'));
  await writeFile(join(runsDir, 'leader', 'PLAN-LOG.md'), '## 2026-11-17T12:40:00Z Update\nReply for Mason: Ready.\nAll checks passed.\n');
  await writeFile(join(runsDir, 'guardian', 'state.json'), JSON.stringify({
    'ashlrai/phantom': { state: 'red', red_first: '2026-11-17T09:00:00Z', attempts: 1 }, 'ashlrai/locus': { state: 'green' } }));
}

/** Readers over fixed inputs; a `null` input is a source that could not be read. */
const fixed = (inputs: Partial<FeedInputs>): FeedReaders => ({
  worklog: async () => inputs.worklog ?? null, proposalMerges: async () => inputs.proposalMerges ?? null,
  outbox: async () => inputs.outbox ?? null, guardian: async () => inputs.guardian ?? null,
});
const ledgerOnly = (emptyReasons = new Map<string, string>()) => worklog(LEDGER, now - 7 * 86_400_000, now, { emptyReasons });

describe('phm feed', () => {
  it('reads one item per meaningful event from every real source, newest first, with a stable v2 schema', async () => {
    await fixture();
    const report = await readFeed({ limit: 30 }, defaultFeedReaders(runsDir), now);
    expect(report).toMatchObject({ schema: 'phantom.feed.v2', version: 2, more: false });
    expect(Object.keys(report.items[0]!).sort()).toEqual(['at', 'count', 'detail', 'href', 'id', 'job', 'kind', 'lane', 'repo', 'text']);
    expect(report.items.map(item => [item.kind, item.text, item.count])).toEqual([
      ['leader', 'Ready. All checks passed.', 1],
      ['released', 'Released ashlrai/phantom v3.30.36', 1],
      ['failed', 'RQ-FAIL failed with exit code 2', 1],
      ['failed', 'RQ-EMPTY ended with no change: reason unknown', 1],
      ['merged', 'Merged #123 Add the feed in phantom', 1],
      ['failed', 'Main went red in ashlrai/phantom', 1],
      ['incident', 'Incident: disk guard paused launches', 1],
      ['lane', 'The codex lane hit its plan limit and is paused', 3],
    ]);
    const byText = new Map(report.items.map(item => [item.text, item]));
    expect(byText.get('Merged #123 Add the feed in phantom')).toMatchObject({ href: 'https://github.com/ashlrai/phantom/pull/123', repo: 'phantom', lane: 'claude', job: 'RQ-MERGE', at: '2026-11-17T11:00:00.000Z' });
    expect(byText.get('Released ashlrai/phantom v3.30.36')!.href).toBe('https://github.com/ashlrai/phantom/releases/tag/v3.30.36');
    expect(byText.get('Main went red in ashlrai/phantom')).toMatchObject({ href: 'https://github.com/ashlrai/phantom/commits', at: '2026-11-17T09:00:00.000Z' });
    expect(byText.get('RQ-FAIL failed with exit code 2')).toMatchObject({ href: '/verse/?pane=worker-log', job: 'RQ-FAIL' });
    expect(byText.get('Incident: disk guard paused launches')!.at).toBe(local('2026-11-17T07:06:00'));
    // Per-tick noise never reaches the feed; secrets never leave it.
    expect(JSON.stringify(report)).not.toMatch(/EMPTY_SIGNAL|LOADGATE|ghp_/);
    expect(Object.values(report.sources).every(state => state === 'available')).toBe(true);
    expect((await readFeed({ limit: 30 }, defaultFeedReaders(runsDir), now + 1000)).items).toEqual(report.items);
  });

  it('names an empty job’s reason when one is known', () => {
    const report = buildFeed({ worklog: ledgerOnly(new Map([['RQ-EMPTY', 'the change was already on main']])), proposalMerges: [], outbox: '', guardian: '{}' }, { limit: 30, kind: 'failed' }, now);
    expect(report.items.map(item => item.text)).toEqual(['RQ-FAIL failed with exit code 2', 'RQ-EMPTY ended with no change: the change was already on main']);
  });

  it('folds identical neighbours and dedupes one PR seen by two sources', () => {
    const merge: FeedItem = { id: 'merged:https://github.com/ashlrai/phantom/pull/123', kind: 'merged', at: '2026-11-17T11:00:00.000Z', text: 'Merged Add the feed in phantom', href: 'https://github.com/ashlrai/phantom/pull/123', repo: 'phantom', lane: null, job: null, detail: null, count: 1 };
    const notice = (at: string): FeedItem => ({ id: `incident:${at}`, kind: 'incident', at, text: 'Incident: same', href: '/verse/?pane=fleet-bus', repo: null, lane: null, job: null, detail: null, count: 1 });
    const noise = { ...notice('2026-11-17T08:30:00Z'), id: 'n', text: 'LOADGATE warn (non-tripping): load 9' };
    const report = buildFeed({ worklog: ledgerOnly(), proposalMerges: [merge, notice('2026-11-17T08:00:00Z'), noise, notice('2026-11-17T09:00:00Z')], outbox: '', guardian: '{}' }, { limit: 30 }, now);
    expect(report.items.filter(item => item.kind === 'merged')).toHaveLength(1);
    expect(report.items.filter(item => item.kind === 'incident')).toEqual([{ ...notice('2026-11-17T09:00:00Z'), count: 2 }]);
  });

  it.each(FEED_KINDS)('filters to --kind %s', async kind => {
    await fixture();
    const report = await readFeed({ limit: 30, kind }, defaultFeedReaders(runsDir), now);
    expect(report.items.length).toBeGreaterThan(0);
    expect(report.items.every(item => item.kind === kind)).toBe(true);
  });

  it('applies --since, --limit and reports more', async () => {
    await fixture();
    const readers = defaultFeedReaders(runsDir);
    const since = await readFeed({ limit: 30, sinceMs: Date.parse('2026-11-17T12:30:00Z') }, readers, now);
    expect(since.items.map(item => item.kind)).toEqual(['leader', 'released']);
    const page = await readFeed({ limit: 2 }, readers, now);
    expect(page).toMatchObject({ more: true, items: since.items });
  });

  it('returns an empty feed with unknown sources when nothing could be read', async () => {
    const report = await readFeed({ limit: 30 }, fixed({}), now);
    expect(report).toEqual({ schema: 'phantom.feed.v2', version: 2, items: [], more: false, next: null,
      sources: { jobs: 'unknown', events: 'unknown', leader: 'unknown', merges: 'unknown', releases: 'unknown', main: 'unknown' } });
    const throwing: FeedReaders = { ...fixed({}), worklog: () => Promise.reject(new Error('boom')) };
    expect((await readFeed({ limit: 30 }, throwing, now)).items).toEqual([]);
    expect(renderFeed(report)).toContain('Nothing happened in this window.');
    const empty = await readFeed({ limit: 30 }, defaultFeedReaders(runsDir), now);
    expect(empty.items).toEqual([]);
    expect(empty.sources).toMatchObject({ jobs: 'unknown', releases: 'unknown', main: 'unknown' });
  });

  it('validates the same query for both callers', () => {
    expect(parseFeedQuery({ limit: '10', since: '1h', kind: 'merged' }, now)).toEqual({ limit: 10, sinceMs: now - 3_600_000, kind: 'merged' });
    expect(parseFeedQuery({ since: '2026-11-18T00:00:00Z' }, now)).toEqual({ limit: 30, sinceMs: Date.parse('2026-11-18T00:00:00Z') });
    for (const since of ['', '0h', '-1h', '8d', '1.5h', 'yesterday', '2026-11-01T00:00:00Z', '2026-11-19T00:00:00Z']) expect(parseFeedQuery({ since }, now)).toBeNull();
    for (const limit of ['0', '1001', 'NaN', '1.5']) expect(parseFeedQuery({ limit }, now)).toBeNull();
    for (const kind of ['merge', 'release', 'blocked', 'lanes', '']) expect(parseFeedQuery({ kind }, now)).toBeNull();
  });

  it('serves the CLI and HTTP from the same report', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await fixture();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFeed(['--json', '--since', '2d', '--kind', 'lane'])).toBe(0);
    const cli = JSON.parse(output.mock.calls.at(-1)![0] as string);
    let status = 0, body = '';
    const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
    await handleApi({ url: '/api/feed?since=2d&kind=lane', method: 'GET' } as IncomingMessage, res, {} as AshlrConfig, { token: '', allowDispatch: false });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual(cli);
    expect(cli.items.map((item: FeedItem) => [item.lane, item.count, item.detail])).toEqual([['codex', 3, 'codex credits exhausted (limit); supervisor clears held in slots.']]);
    expect(await cmdFeed(['--since', '2d', '--kind', 'lane'])).toBe(0);
    expect(output.mock.calls.at(-1)![0]).toContain('(x3)  /verse/?pane=fleet-lanes');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [['--since', 'oops'], ['--kind', 'merge'], ['--kind'], ['--bogus']]) expect(await cmdFeed(args)).toBe(2);
    await handleApi({ url: '/api/feed?kind=nope', method: 'GET' } as IncomingMessage, res, {} as AshlrConfig, { token: '', allowDispatch: false });
    expect(status).toBe(400);
  });
});
