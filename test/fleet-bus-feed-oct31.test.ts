import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBusHops, parseDispatchEvents, readFleetBusFeed } from '../src/core/fleet/bus-feed.js';

const dirs: string[] = [];
async function fixture() {
  const runsDir = await mkdtemp(join(tmpdir(), 'bus-feed-'));
  dirs.push(runsDir);
  return { runsDir, hopsFile: join(runsDir, 'hops.jsonl') };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const hop = (id: string) => JSON.stringify({ id, from: 'leader', to: 'worker', inputTokens: 12, outputTokens: null });
const event = (kind: string, text = 'sample') => `2026-10-31 00:47:39 ${kind} ${text}`;
// Hop logs must be private (0600) and unfinished final rows are excluded, so fixtures write both that way.
const writeHops = (file: string, text: string) => writeFile(file, text, { mode: 0o600 });

describe('fleet bus feed reader', () => {
  it('projects hop metadata, scrubs identities and counts malformed rows', () => {
    const secret = 'sk-' + 'FAKE0000000000000000';
    const parsed = parseBusHops([hop('one'), 'bad', '{}', 'null', hop(secret),
      JSON.stringify({ id: 'bad', from: 'a', to: 'b', inputTokens: -1, outputTokens: 0 }),
      JSON.stringify({ id: 'bad', from: 'a', to: 'b', inputTokens: 1.5, outputTokens: 0 }), ''].join('\n'));
    // A secret-shaped id is rejected by the hop contract rather than scrubbed into a row (see bus-feed-canonical-31t1).
    expect(parsed.dropped).toBe(6);
    expect(parsed.hops[0]).toEqual({ id: 'one', from: 'leader', to: 'worker', inputTokens: 12, outputTokens: null });
    expect(JSON.stringify(parsed.hops)).not.toContain(secret);
    expect(Object.keys(parsed.hops[0])).toHaveLength(5);
  });

  it('classifies dispatch events and excludes other kinds when five recognized remain', () => {
    const rows = parseDispatchEvents([
      '2026-10-31 00:47:39 INBOX new entry from Phantom desktop',
      '2026-10-31 00:12:01 INCIDENT no launch and no merge in 30 min; ...',
      ...['ORCH-LEADER', 'LANE_HOLD', 'LAUNCH', 'PUBLISHED', 'NOISE'].map((kind) => event(kind)),
      'no timestamp', '2026-99-99 99:99:99 INBOX invalid',
    ].join('\n'));
    expect(rows.map((row) => row.kind)).toEqual(['inbox', 'incident', 'orch', 'lane-hold', 'launch', 'published']);
    expect(rows[0].at).toBe('2026-10-31 00:47:39');
  });

  it('fills to five with recent other events and preserves file order', () => {
    const rows = parseDispatchEvents([event('INBOX'), ...Array.from({ length: 8 }, (_, i) => event('NOTE', String(i)))].join('\n'));
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.text)).toEqual(['INBOX sample', 'NOTE 4', 'NOTE 5', 'NOTE 6', 'NOTE 7']);
  });

  it('reports missing and degraded sources independently without throwing', async () => {
    const opts = await fixture();
    expect(await readFleetBusFeed(opts)).toEqual({ v: 1, hops: [], hopsDropped: 0, lastHopAt: null,
      events: [], sources: { hops: 'missing', events: 'missing' } });
    expect((await readFleetBusFeed({ ...opts, hopsFile: opts.runsDir })).sources).toEqual({ hops: 'degraded', events: 'missing' });
  });

  it('bounds both tails and discards initial partial lines without counting them as malformed', async () => {
    const opts = await fixture();
    await writeHops(opts.hopsFile, 'x'.repeat(300_000) + '\n' + hop('last') + '\n');
    await writeFile(join(opts.runsDir, 'dispatch-events.log'), 'x'.repeat(300_000) + '\n' + event('LAUNCH') + '\n');
    const result = await readFleetBusFeed(opts);
    expect(result.hops.map((row) => row.id)).toEqual(['last']);
    expect(result.hopsDropped).toBe(0);
    // The hop log carries no timestamps; lastHopAt is always null (FleetBusFeedV1, bus-feed-canonical-31t1).
    expect(result.lastHopAt).toBeNull();
    expect(result.events.map((row) => row.kind)).toEqual(['launch']);
    // The oversized hop log was cut at the read window, so its history is incomplete (bus-feed-canonical-31t1).
    expect(result.sources).toEqual({ hops: 'degraded', events: 'healthy' });
  });

  it('defaults and clamps limits, keeping newest rows last', async () => {
    const opts = await fixture();
    await writeHops(opts.hopsFile, Array.from({ length: 510 }, (_, i) => hop(String(i))).join('\n') + '\n');
    await writeFile(join(opts.runsDir, 'dispatch-events.log'), Array.from({ length: 510 }, (_, i) => event('INBOX', String(i))).join('\n') + '\n');
    for (const [limit, length] of [[undefined, 100], [0, 1], [-3, 1], [900, 500], [2, 2]] as const) {
      const result = await readFleetBusFeed({ ...opts, limit });
      expect(result.hops).toHaveLength(length);
      expect(result.events).toHaveLength(length);
      expect(result.hops.at(-1)?.id).toBe('509');
    }
  });

  it('scrubs event secrets before truncating text to 400 characters', async () => {
    const opts = await fixture();
    const secret = 'sk-' + 'FAKE0000000000000000';
    await writeFile(join(opts.runsDir, 'dispatch-events.log'), event('INBOX', secret + ' ' + 'words '.repeat(100)) + '\n');
    const result = await readFleetBusFeed(opts);
    expect(result.events[0].text).not.toContain(secret);
    expect(result.events[0].text).toHaveLength(400);
  });
});
