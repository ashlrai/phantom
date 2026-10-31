import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBusHops, readFleetBusFeed } from '../src/core/fleet/bus-feed.js';

const dirs: string[] = [];
async function fixture() {
  const runsDir = await mkdtemp(join(tmpdir(), 'bus-canonical-'));
  dirs.push(runsDir);
  return { runsDir, hopsFile: join(runsDir, 'hops.jsonl') };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const hop = (id: string) => ({ id, from: 'leader', to: 'worker', inputTokens: 3, outputTokens: null });
const line = (value: unknown) => JSON.stringify(value) + '\n';
const writeHops = (file: string, text: string) => writeFile(file, text, { mode: 0o600 });

describe('canonical fleet bus feed', () => {
  it('validates complete text rows with the hop contract and excludes the unfinished row', () => {
    const secret = 'sk-' + 'FAKE0000000000000000';
    const text = line({ id: 'unknown', from: 'a', to: 'b', body: 'private body' }) +
      line(hop('has space')) + line(hop(secret)) + line({ ...hop('bad'), inputTokens: -1 }) +
      line({ ...hop('bad'), outputTokens: 1.5 }) + '\n' + JSON.stringify(hop('unfinished'));
    const result = parseBusHops(text);
    expect(result).toEqual({ hops: [{ id: 'unknown', from: 'a', to: 'b', inputTokens: null, outputTokens: null }], dropped: 6 });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('private body');
    expect(parseBusHops('')).toEqual({ hops: [], dropped: 0 });
  });

  it('reports validated metadata, invalid and unfinished rows, without inventing a timestamp', async () => {
    const opts = await fixture();
    const secret = 'sk-' + 'FAKE0000000000000000';
    await writeHops(opts.hopsFile, line({ id: 'valid', from: 'a', to: 'b', extra: 'private body' }) +
      line(hop(secret)) + line(hop('bad id')) + 'invalid\n' + JSON.stringify(hop('pending')));
    await writeFile(join(opts.runsDir, 'dispatch-events.log'), `2026-10-31 00:47:39 INBOX ${secret} ${'words '.repeat(100)}\n`);
    const feed = await readFleetBusFeed(opts);
    expect(feed).toMatchObject({ v: 1, hops: [{ id: 'valid', from: 'a', to: 'b', inputTokens: null, outputTokens: null }],
      hopsDropped: 4, lastHopAt: null, sources: { hops: 'degraded', events: 'healthy' } });
    expect(feed.events[0].text).toHaveLength(400);
    expect(JSON.stringify(feed)).not.toContain(secret);
    expect(JSON.stringify(feed)).not.toContain('private body');
  });

  it('distinguishes missing, unsafe, and healthy private sources', async () => {
    const opts = await fixture();
    expect((await readFleetBusFeed(opts)).sources).toEqual({ hops: 'missing', events: 'missing' });
    expect((await readFleetBusFeed({ ...opts, hopsFile: opts.runsDir })).sources.hops).toBe('degraded');
    await writeHops(opts.hopsFile, line(hop('good')));
    expect(await readFleetBusFeed(opts)).toMatchObject({ hops: [hop('good')], hopsDropped: 0, lastHopAt: null,
      sources: { hops: 'healthy', events: 'missing' } });
    if (process.platform !== 'win32') {
      await chmod(opts.hopsFile, 0o644);
      expect(await readFleetBusFeed(opts)).toMatchObject({ hops: [], hopsDropped: 0, lastHopAt: null,
        sources: { hops: 'degraded', events: 'missing' } });
    }
  });

  it('retains the newest rows at the cap and marks incomplete observations degraded', async () => {
    const opts = await fixture();
    await writeHops(opts.hopsFile, Array.from({ length: 510 }, (_, i) => line(hop(String(i)))).join(''));
    const feed = await readFleetBusFeed({ ...opts, limit: 900 });
    expect(feed.hops).toHaveLength(500);
    expect(feed.hops[0].id).toBe('10');
    expect(feed.hops.at(-1)?.id).toBe('509');
    expect(feed.hopsDropped).toBe(0);
    expect(feed.sources.hops).toBe('degraded');
    await writeHops(opts.hopsFile, 'x'.repeat(300_000) + '\n' + line(hop('last')));
    const truncated = await readFleetBusFeed(opts);
    expect(truncated).toMatchObject({ hops: [hop('last')], hopsDropped: 0, lastHopAt: null, sources: { hops: 'degraded' } });
  });
});
