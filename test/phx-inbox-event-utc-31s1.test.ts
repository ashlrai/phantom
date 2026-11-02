import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDispatchEvents as parseBusEvents } from '../src/core/fleet/bus-feed.js';
import { appendInboxEntry, readInboxEntries } from '../src/core/fleet/mason-inbox.js';
import { parseDispatchEvents as parseRunsEvents } from '../src/core/fleet/runs-dir-state.js';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'inbox-event-utc-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('inbox dispatch event timestamps', () => {
  it.each([
    ['winter', '2026-01-02T05:04:05.000Z', '2026-01-02 00:04'],
    ['summer', '2026-07-04T16:03:02.000Z', '2026-07-04 12:03'],
    ['before spring transition', '2026-03-08T06:59:59.000Z', '2026-03-08 01:59'],
    ['after spring transition', '2026-03-08T07:00:00.000Z', '2026-03-08 03:00'],
    ['before fall transition', '2026-11-01T05:59:59.000Z', '2026-11-01 01:59'],
    ['after fall transition', '2026-11-01T06:00:00.000Z', '2026-11-01 01:00'],
    ['shared channel context', '2026-10-31T04:13:00.000Z', '2026-10-31 00:13'],
  ])('writes UTC for %s while keeping the inbox in Eastern time', async (_label, instant, eastern) => {
    const text = 'Shared context\nSecond line\n\nFinal line';
    const source = 'desktop';
    const entry = `\n## ${eastern} ET (Mason, ${source}) PRIORITY P0\n${text}\n`;
    expect(await appendInboxEntry(text, { runsDir, source, now: () => new Date(instant) })).toEqual({
      ok: true, at: eastern, bytes: Buffer.byteLength(entry),
    });
    expect(await readFile(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8')).toBe(entry);
    expect(await readInboxEntries({ runsDir })).toEqual({ sourceState: 'healthy', entries: [
      { at: eastern, source, priority: 'P0', text },
    ] });

    const log = await readFile(join(runsDir, 'dispatch-events.log'), 'utf8');
    const bus = parseBusEvents(log);
    const runs = parseRunsEvents(log);
    expect(bus).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(new Date(bus[0].at.replace(' ', 'T') + 'Z').toISOString()).toBe(instant);
    expect(new Date(runs[0].at).toISOString()).toBe(instant);
    expect(bus[0]).toMatchObject({ kind: 'inbox', text: `INBOX new entry from ${source}` });
    expect(runs[0]).toMatchObject({ kind: 'INBOX', text: `new entry from ${source}` });
  });
});
