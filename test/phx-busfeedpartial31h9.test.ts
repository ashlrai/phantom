import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFleetBusFeed } from '../src/core/fleet/bus-feed.js';

const dirs: string[] = [];
async function fixture() {
  const runsDir = await mkdtemp(join(tmpdir(), 'bus-feed-partial-'));
  dirs.push(runsDir);
  return { runsDir, hopsFile: join(runsDir, 'hops.jsonl'), log: join(runsDir, 'dispatch-events.log') };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('dispatch feed incomplete records', () => {
  it('retains complete events and exposes an appended event only after its newline', async () => {
    const { log, ...opts } = await fixture();
    await writeFile(log, '2026-10-31 00:00:00 INBOX previous\n2026-10-31 00:00:01 LAUNCH partial');

    const partial = await readFleetBusFeed(opts);
    expect(partial.events.map((event) => event.text)).toEqual(['INBOX previous']);
    expect(partial.sources).toEqual({ hops: 'missing', events: 'degraded' });

    await appendFile(log, ' complete\n');
    const complete = await readFleetBusFeed(opts);
    expect(complete.events.map((event) => event.text)).toEqual(['INBOX previous', 'LAUNCH partial complete']);
    expect(complete.sources).toEqual({ hops: 'missing', events: 'healthy' });
  });

  it('discards the cut leading record and the unfinished trailing record in a bounded tail', async () => {
    const { log, ...opts } = await fixture();
    await writeFile(log, '2026-10-31 00:00:00 INBOX ' + 'x'.repeat(300_000) +
      '\n2026-10-31 00:00:01 INCIDENT retained\n2026-10-31 00:00:02 LAUNCH pending');
    const partial = await readFleetBusFeed(opts);
    expect(partial.events.map((event) => event.text)).toEqual(['INCIDENT retained']);
    expect(partial.sources.events).toBe('degraded');

    await appendFile(log, '\n');
    const complete = await readFleetBusFeed(opts);
    expect(complete.events.map((event) => event.text)).toEqual(['INCIDENT retained', 'LAUNCH pending']);
    expect(complete.sources.events).toBe('healthy');
  });

  it('marks a tail containing only an oversized unfinished record degraded', async () => {
    const { log, ...opts } = await fixture();
    await writeFile(log, '2026-10-31 00:00:00 LAUNCH ' + 'x'.repeat(300_000));
    expect(await readFleetBusFeed(opts)).toMatchObject({ events: [], sources: { events: 'degraded' } });
    await writeFile(log, '');
    expect(await readFleetBusFeed(opts)).toMatchObject({ events: [], sources: { events: 'healthy' } });
  });
});
