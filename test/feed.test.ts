import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { orderFeed, parseFeedQuery, readFeed, type FeedItem } from '../src/core/feed.js';
import { cmdFeed } from '../src/cli/feed.js';
import { writeReleaseNotices } from '../src/core/fleet/release-live-notice.js';
import { handleApi } from '../src/core/web/api.js';
import type { AshlrConfig } from '../src/core/types.js';

const now = Date.parse('2026-11-17T13:00:00Z');
let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'feed-'));
  await mkdir(join(runsDir, 'metrics'));
  await mkdir(join(runsDir, 'leader'));
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  vi.stubEnv('PHANTOM_PLAN_LOG', join(runsDir, 'leader', 'PLAN-LOG.md'));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(runsDir, { recursive: true, force: true }); });

async function fixture() {
  await writeFile(join(runsDir, 'metrics', 'jobs.jsonl'), [
    { event: 'outcome', job: 'RQ-MERGE', repo: 'phantom', ts: '2026-11-17T12:10:00Z', outcome: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/123' },
    { event: 'outcome', job: 'RQ-NO', ts: '2026-11-17T12:11:00Z', outcome: 'NOT_MERGED' },
    { event: 'outcome', job: 'ghp_' + 'x'.repeat(36), ts: '2026-11-17T12:12:00Z', outcome: 'MERGED' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n{malformed}\n');
  await writeFile(join(runsDir, 'dispatch-events.log'), '2026-11-17 07:20:00 PARKED RQ-BLOCK [precheck code=13 reason=dependency not merged]\ninvalid event\n');
  writeReleaseNotices([{ repo: 'ashlrai/phantom', tag: 'v3.30.36', publishedAt: '2026-11-17T12:25:00Z',
    url: 'https://github.com/ashlrai/phantom/releases/tag/v3.30.36', draft: false, prerelease: false }], runsDir, new Date('2026-11-17T12:30:00Z'));
  await writeFile(join(runsDir, 'leader', 'PLAN-LOG.md'), '## 2026-11-17T12:40:00Z Update\nReply for Mason: Ready.\nAll checks passed.\n');
}

describe('feed', () => {
  it('orders events from both sources before applying the limit', () => {
    const items: FeedItem[] = [
      { kind: 'merge', at: '2026-01-01T00:00:00Z', text: 'old' },
      { kind: 'leader-reply', at: '2026-01-03T00:00:00Z', text: 'new' },
      { kind: 'merge', at: '2026-01-02T00:00:00Z', text: 'middle' },
      { kind: 'leader-reply', at: '', text: 'unknown time' },
    ];
    expect(orderFeed(items, 2).map(item => item.text)).toEqual(['new', 'middle']);
  });

  it('reads each real event format, ignoring malformed events and non-merged outcomes', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    await fixture();
    const report = await readFeed(30, { runsDir, now });
    expect(report.items.map(item => item.kind)).toEqual(['leader-reply', 'release', 'blocked', 'merge']);
    expect(report.items.every(item => item.id && item.href && !item.text.includes('\n'))).toBe(true);
    expect(report.items[0]!.text).toBe('Ready. All checks passed.');
    expect(report.items[1]).toMatchObject({ at: '2026-11-17T12:30:00.000Z', href: 'https://github.com/ashlrai/phantom/releases/tag/v3.30.36' });
    expect(report.items[2]!.text).toBe('RQ-BLOCK blocked: dependency not merged');
    expect(report.items[2]!.href).toBe('/verse/?pane=fleet-bus');
    expect(JSON.stringify(report)).not.toContain('ghp_' + 'x'.repeat(36));
    expect(report.items[3]!.href).toBe('https://github.com/ashlrai/phantom/pull/123');
    expect((await readFeed(30, { runsDir, now: now + 60_000 })).items).toEqual(report.items);
    expect((await readFeed(1, { runsDir, now, sinceMs: Date.parse('2026-11-17T12:30:00Z') })).items).toEqual(report.items.slice(0, 1));
  });

  it('keeps missing sources unknown and returns an empty stream', async () => {
    const report = await readFeed(30, { runsDir, now });
    expect(report.items).toEqual([]);
    expect(report.sources).toMatchObject({ releases: 'unknown', incidents: 'unknown', leaderReplies: 'unknown' });
  });

  it('validates the same since and limit bounds for both callers', () => {
    expect(parseFeedQuery('10', '1h', now)).toEqual({ limit: 10, sinceMs: now - 3_600_000 });
    for (const since of ['', '0h', '-1h', '8d', '1.5h', 'yesterday']) expect(parseFeedQuery('30', since)).toBeNull();
    for (const limit of ['0', '1001', 'NaN', '1.5']) expect(parseFeedQuery(limit, '1h')).toBeNull();
    const item: FeedItem = { id: 'same', kind: 'merge', at: new Date(now).toISOString(), text: 'Merged' };
    expect(orderFeed([item, item], 30, now, now)).toEqual([item]);
    expect(orderFeed([item], 30, now + 1)).toEqual([]);
    expect(orderFeed([item], 30, 0, now - 1)).toEqual([]);
  });

  it('serves the CLI and HTTP from the same filtered report, including links in text', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await fixture();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFeed(['--json', '--since', '1h'])).toBe(0);
    const cli = JSON.parse(output.mock.calls.at(-1)![0] as string);
    let status = 0, body = '';
    const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
    await handleApi({ url: '/api/feed?since=1h', method: 'GET' } as IncomingMessage, res, {} as AshlrConfig, { token: '', allowDispatch: false });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual(cli);
    expect(await cmdFeed(['--since', '1h'])).toBe(0);
    expect(output.mock.calls.at(-1)![0]).toContain(cli.items[0].href);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFeed(['--since', 'oops'])).toBe(2);
    await handleApi({ url: '/api/feed?since=oops', method: 'GET' } as IncomingMessage, res, {} as AshlrConfig, { token: '', allowDispatch: false });
    expect(status).toBe(400);
  });
});
