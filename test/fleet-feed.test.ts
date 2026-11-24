/**
 * The Feed's pure projection (core/feed.ts buildFeed) on fixed inputs: every kind in
 * plain words, bursts of merges as one card, duplicates dropped, the `next` cursor,
 * an empty feed, and the `phm feed --json` shape. No home directory or network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFeed, parseFeedQuery, type FeedInputs, type FeedItem, type FeedReport } from '../src/core/feed.js';
import { cmdFeed, renderFeed } from '../src/cli/feed.js';
import { parseDispatchEvents } from '../src/core/fleet/bus-feed.js';
import { eventRows, leaderRows, worklog } from '../src/core/fleet/worklog.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const week = now - 7 * 86_400_000;
// Dispatch event lines carry local wall-clock times; pin the zone so they parse the same everywhere.
beforeEach(() => { vi.stubEnv('TZ', 'UTC'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const pull = (n: number, repo = 'phantom') => `https://github.com/ashlrai/${repo}/pull/${n}`;
const merge = (n: number, ts: string, repo = 'phantom') => [
  { event: 'launch', job: `RQ-${n}`, repo, lane: 'claude', title: `Change ${n}`, ts: '2026-11-18T06:00:00Z' },
  { event: 'publish', job: `RQ-${n}`, url: pull(n, repo), ts: '2026-11-18T06:30:00Z' },
  { event: 'outcome', state: 'MERGED', url: pull(n, repo), ts },
];
const EVENTS = [
  '2026-11-18 08:00:00 LANE_HOLD codex credits exhausted (limit); supervisor clears held in slots.json',
  '2026-11-18 08:10:00 LANE_HOLD devin autobackoff pattern=auth job=RQ-9 until=later src=default',
  '2026-11-18 08:20:00 LANE_HOLD placed grok by phantom: budget review (until 2026-11-18T10:00:00Z)',
  '2026-11-18 08:30:00 LANE_HOLD released codex by usage-reset: the plan window reset',
  '2026-11-18 08:40:00 LANE_UNHOLD devin autobackoff expired',
  '2026-11-18 08:50:00 LANE_HOLD stopped RQ-7 by mason: wrong repo',
  '2026-11-18 09:00:00 INCIDENT disk guard paused launches',
].join('\n') + '\n';
const OUTBOX = '\n## 2026-11-18T09:30:00.000Z Release live: ashlrai/phantom v3.31.0\n\nashlrai/phantom v3.31.0 is released and published.\n';
const GUARDIAN = JSON.stringify({ 'ashlrai/phantom': { state: 'red', red_first: '2026-11-18T07:00:00Z' }, 'ashlrai/locus': { state: 'green' } });

function inputs(ledger: object[], more: Partial<FeedInputs> = {}): FeedInputs {
  const rows = [...eventRows(parseDispatchEvents(EVENTS)), ...leaderRows([{ at: '2026-11-18T10:00:00Z', text: 'The update is ready.' }])];
  return { worklog: worklog(ledger.map(row => JSON.stringify(row)).join('\n'), week, now, { rows }), proposalMerges: [], outbox: OUTBOX, guardian: GUARDIAN, ...more };
}
const feed = (ledger: object[], query: Parameters<typeof buildFeed>[1] = { limit: 100 }, more: Partial<FeedInputs> = {}) => buildFeed(inputs(ledger, more), query, now);

describe('the fleet feed', () => {
  it('turns every kind of fleet event into one plain-words item, newest first', () => {
    const report = feed([...merge(1, '2026-11-18T11:00:00Z'), { event: 'finish', job: 'RQ-FAIL', repo: 'locus', lane: 'codex', exit_code: 2, ts: '2026-11-18T10:30:00Z' }]);
    expect(report.items.map(item => [item.kind, item.text, item.lane])).toEqual([
      ['merged', 'Merged #1 Change 1 in phantom', 'claude'],
      ['failed', 'RQ-FAIL failed with exit code 2', 'codex'],
      ['leader', 'The update is ready.', null],
      ['released', 'Released ashlrai/phantom v3.31.0', null],
      ['incident', 'Incident: disk guard paused launches', null],
      ['incident', 'Lane hold: stopped RQ-7 by mason: wrong repo', null],
      ['lane', 'The devin lane is running again', 'devin'],
      ['lane', 'The codex lane was reset and is running again', 'codex'],
      ['lane', 'The grok lane was paused', 'grok'],
      ['lane', 'The devin lane was paused after repeated failures', 'devin'],
      ['lane', 'The codex lane hit its plan limit and is paused', 'codex'],
      ['failed', 'Main went red in ashlrai/phantom', null],
    ]);
    // Every item has the same fields, a time, and somewhere to go.
    for (const item of report.items) {
      expect(Object.keys(item).sort()).toEqual(['at', 'count', 'detail', 'href', 'id', 'job', 'kind', 'lane', 'repo', 'text']);
      expect(new Date(item.at).toISOString()).toBe(item.at);
      expect(item.href).toMatch(/^(?:https:\/\/github\.com\/|\/verse\/\?pane=)/);
    }
    const lane = report.items.find(item => item.text.includes('plan limit'))!;
    expect(lane).toMatchObject({ detail: 'codex credits exhausted (limit); supervisor clears held in slots.json', href: '/verse/?pane=fleet-lanes', count: 1 });
    expect(new Set(report.items.map(item => item.id)).size).toBe(report.items.length);
    expect(Object.values(report.sources).every(state => state === 'available')).toBe(true);
  });

  it('groups a burst of merges in one repo into one card that lists them', () => {
    const burst = Array.from({ length: 12 }, (_, i) => merge(i + 1, `2026-11-18T11:${String(10 + i * 4).padStart(2, '0')}:00Z`)).flat();
    const report = feed([...burst, ...merge(40, '2026-11-18T11:20:00Z', 'locus'), ...merge(41, '2026-11-18T09:05:00Z'), ...merge(42, '2026-11-18T09:15:00Z')], { limit: 100, kind: 'merged' });
    expect(report.items.map(item => [item.text, item.group?.length ?? 0])).toEqual([
      ['12 PRs merged in phantom in the last hour', 12],
      // One merge in another repo and two in an earlier hour are below a burst and stay single.
      ['Merged #40 Change 40 in locus', 0], ['Merged #42 Change 42 in phantom', 0], ['Merged #41 Change 41 in phantom', 0],
    ]);
    const card = report.items[0]!;
    expect(card).toMatchObject({ id: 'merged:burst:phantom:2026-11-18T11', at: '2026-11-18T11:54:00.000Z', href: '/verse/?pane=fleet-merges', repo: 'phantom', count: 1 });
    expect(card.group![0]).toEqual({ text: 'Merged #12 Change 12 in phantom', href: pull(12), at: '2026-11-18T11:54:00.000Z' });
    expect(card.group!.map(entry => entry.at)).toEqual([...card.group!.map(entry => entry.at)].sort().reverse());
    // An older burst is not "in the last hour", and the CLI lists a burst's merges under its line.
    const older = buildFeed(inputs(burst), { limit: 100, kind: 'merged' }, now + 3 * 3_600_000);
    expect(older.items[0]!.text).toBe('12 PRs merged in phantom within an hour');
    expect(renderFeed(report).split('\n').filter(line => line.startsWith('    Merged #'))).toHaveLength(12);
  });

  it('drops duplicates: one PR seen by two sources, and one event recorded twice', () => {
    const same: FeedItem = { id: `merged:${pull(1)}`, kind: 'merged', at: '2026-11-18T11:00:00.000Z', text: 'Merged Change 1 in phantom', detail: null, href: pull(1), repo: 'phantom', lane: null, job: null, count: 1 };
    const report = feed([...merge(1, '2026-11-18T11:00:00Z'), ...merge(1, '2026-11-18T11:00:00Z')], { limit: 100 }, { proposalMerges: [same, same], outbox: OUTBOX + OUTBOX });
    expect(report.items.filter(item => item.kind === 'merged')).toHaveLength(1);
    expect(report.items.filter(item => item.kind === 'released')).toHaveLength(1);
  });

  it('hands back a cursor that reads only newer events', () => {
    const ledger = [...merge(1, '2026-11-18T10:45:00Z')];
    const first = feed(ledger);
    expect(first.next).toBe('2026-11-18T10:45:00.001Z');
    // Nothing new: the same cursor comes back, so a poller never loses its place.
    const idle = feed(ledger, parseFeedQuery({ since: first.next! }, now)!);
    expect(idle).toMatchObject({ items: [], more: false, next: first.next });
    const later = feed([...ledger, ...merge(2, '2026-11-18T11:30:00Z')], parseFeedQuery({ since: first.next! }, now)!);
    expect(later.items.map(item => item.text)).toEqual(['Merged #2 Change 2 in phantom']);
    expect(later.next).toBe('2026-11-18T11:30:00.001Z');
    // The cursor follows the newest event even when `limit` hides older ones, and `kind` narrows it.
    expect(feed(ledger, { limit: 1 })).toMatchObject({ more: true, next: first.next });
    expect(feed(ledger, { limit: 100, kind: 'lane', sinceMs: Date.parse('2026-11-18T08:25:00Z') }).items.map(item => item.lane)).toEqual(['devin', 'codex']);
  });

  it('is empty, not broken, when nothing happened or nothing could be read', () => {
    const quiet = buildFeed({ worklog: worklog('', week, now), proposalMerges: [], outbox: '', guardian: '{}' }, { limit: 30 }, now);
    expect(quiet).toMatchObject({ items: [], more: false, next: null });
    expect(Object.values(quiet.sources).every(state => state === 'available')).toBe(true);
    const dark = buildFeed({ worklog: null, proposalMerges: null, outbox: null, guardian: null }, { limit: 30 }, now);
    expect(dark.items).toEqual([]);
    expect(Object.values(dark.sources).every(state => state === 'unknown')).toBe(true);
    expect(renderFeed(dark)).toBe('Nothing happened in this window.\nUnknown sources: jobs, events, leader, merges, releases, main');
  });

  it('prints the same typed report from `phm feed --json`', async () => {
    const report = feed(Array.from({ length: 3 }, (_, i) => merge(i + 1, `2026-11-18T11:0${i}:00Z`)).flat(), { limit: 2 });
    const read = vi.fn(async () => report);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(await cmdFeed(['--json', '--since', '1h', '--kind', 'lane', '--limit', '2'], read)).toBe(0);
    expect(read).toHaveBeenCalledWith({ limit: 2, kind: 'lane', sinceMs: now - 3_600_000 });
    const printed = JSON.parse(output.mock.calls.at(-1)![0] as string) as FeedReport;
    expect(printed).toEqual(report);
    expect(Object.keys(printed).sort()).toEqual(['items', 'more', 'next', 'schema', 'sources', 'version']);
    expect(printed).toMatchObject({ schema: 'phantom.feed.v2', version: 2, more: true, next: '2026-11-18T11:02:00.001Z' });
    expect(Object.keys(printed.items[0]!).sort()).toEqual(['at', 'count', 'detail', 'group', 'href', 'id', 'job', 'kind', 'lane', 'repo', 'text']);
    expect(Object.keys(printed.items[0]!.group![0]!).sort()).toEqual(['at', 'href', 'text']);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFeed(['--kind', 'lanes'], read)).toBe(2);
  });
});
