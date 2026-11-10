/**
 * Recut of #1166: typed dispatch-events.log parser behind
 * `phm fleet dispatch-events`. Covers the PR's ISO grammar plus the
 * `%F %T KIND payload` local-clock rows dispatchd actually writes.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultDispatchEventsPath,
  dispatchTimestampMs,
  parseDispatchEventLine,
  readDispatchEvents,
} from '../src/core/fabric/dispatch-events.js';
import { cmdFleetDispatchEvents } from '../src/cli/fleet-dispatch-events.js';
import { cmdFleet } from '../src/cli/fleet.js';

const fixture = fileURLToPath(new URL('./fixtures/dispatch-events/events.txt', import.meta.url));
afterEach(() => vi.restoreAllMocks());

/** The local wall clock dispatchd's `time.strftime("%F %T")` writes for an instant. */
function localClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'recut-queue-1166-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('dispatch event parser', () => {
  it.each(['RESTOCK', 'LAUNCH_FAILED', 'PUBLISH_STARTED', 'PUBLISH_FAILED', 'PUBLISH_SUCCESS', 'LANE_HOLD', 'PUBLISH_RETRY_SCHEDULED'])(
    'parses the ISO %s fixture row', async (kind) => {
      const line = (await readFile(fixture, 'utf8')).split('\n').find((row) => row.includes(` ${kind} `))!;
      const parsed = parseDispatchEventLine(line);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.event.kind).toBe(kind);
        expect(parsed.event.message).toContain('=');
        expect(Date.parse(parsed.event.at)).toBe(dispatchTimestampMs(parsed.event.timestamp));
      }
    });

  it('parses the local-clock rows dispatchd writes', () => {
    const ms = Date.UTC(2026, 10, 9, 23, 1, 2);
    const line = `${localClock(ms)} LAUNCH RQ-X pool=claude`;
    expect(parseDispatchEventLine(line)).toEqual({
      ok: true,
      event: { timestamp: localClock(ms), at: new Date(ms).toISOString(), kind: 'LAUNCH', message: 'RQ-X pool=claude' },
    });
    expect(parseDispatchEventLine(`${localClock(ms)} DISKGUARD`)).toMatchObject({ ok: true, event: { kind: 'DISKGUARD', message: '' } });
  });

  it.each([
    '', 'garbage', '2026-10-26 RESTOCK x', '2026-02-30T00:00:00Z RESTOCK x', '2026-02-30 10:00:00 RESTOCK x',
    '2026-10-26 24:00:00 RESTOCK x', '2026-10-26T24:00:00Z RESTOCK x', '2026-10-26T00:00:00 RESTOCK x',
    '2026-10-26T00:00:00Z PUBLISH_ x', '2026-10-26T00:00:00Z lower x', '2026-10-26 10:00:00 Lower x',
    '2026-10-26T00:00:00Z RESTOCK x\nsecond line',
  ])('rejects malformed record %j', (line) => {
    expect(parseDispatchEventLine(line).ok).toBe(false);
  });

  it('keeps payload text inert and supports an empty payload and CRLF', () => {
    expect(parseDispatchEventLine('2026-10-26T00:00:00Z RESTOCK\r')).toEqual({
      ok: true, event: { timestamp: '2026-10-26T00:00:00Z', at: '2026-10-26T00:00:00.000Z', kind: 'RESTOCK', message: '' },
    });
    expect(parseDispatchEventLine('2026-10-26T00:00:00Z LANE_HOLD reason=$(false)'))
      .toMatchObject({ ok: true, event: { message: 'reason=$(false)' } });
  });
});

describe('dispatch event reader', () => {
  it('reads every fixture record and counts malformed and blank lines', async () => {
    const report = await readDispatchEvents({ path: fixture });
    expect(report.events).toHaveLength(7);
    expect(report).toMatchObject({ source: 'present', malformedLines: 4, emptyLines: 1, truncated: 0 });
  });

  it('filters inclusively by instant across timezone offsets and local-clock rows', async () => {
    expect((await readDispatchEvents({ path: fixture, since: '2026-10-26T18:04:00Z' })).events.map((e) => e.kind))
      .toEqual(['PUBLISH_SUCCESS', 'LANE_HOLD', 'PUBLISH_RETRY_SCHEDULED']);
    await withDir(async (dir) => {
      const path = join(dir, 'dispatch-events.log');
      const base = Date.UTC(2026, 10, 9, 12, 0, 0);
      await writeFile(path, [0, 60_000, 120_000].map((d, i) => `${localClock(base + d)} SLOTS n=${i}`).join('\n'));
      const report = await readDispatchEvents({ path, since: new Date(base + 60_000).toISOString() });
      expect(report.events.map((e) => e.message)).toEqual(['n=1', 'n=2']);
    });
  });

  it('distinguishes a missing log from an unreadable one and accepts a final line without newline', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'events.log');
      expect(await readDispatchEvents({ path })).toMatchObject({ source: 'missing', events: [] });
      await expect(readDispatchEvents({ path: dir })).rejects.toThrow();
      await writeFile(path, '2026-10-26T18:00:00Z RESTOCK count=1\r\n2026-10-26 18:01:00 LANE_HOLD');
      expect((await readDispatchEvents({ path })).events).toHaveLength(2);
    });
  });

  it('keeps only the newest events past the bound and counts the rest', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'events.log');
      await writeFile(path, Array.from({ length: 25 }, (_, i) => `2026-10-26T18:00:${String(i).padStart(2, '0')}Z LAUNCH n=${i}`).join('\n'));
      const report = await readDispatchEvents({ path, max: 4 });
      expect(report.events.map((e) => e.message)).toEqual(['n=21', 'n=22', 'n=23', 'n=24']);
      expect(report.truncated).toBe(21);
    });
  });

  it('defaults to the queue log, then the runs-root log', async () => {
    await withDir(async (runsDir) => {
      expect(await defaultDispatchEventsPath(runsDir)).toBe(join(runsDir, 'queue', 'dispatch-events.log'));
      await writeFile(join(runsDir, 'dispatch-events.log'), '');
      expect(await defaultDispatchEventsPath(runsDir)).toBe(join(runsDir, 'dispatch-events.log'));
      await mkdir(join(runsDir, 'queue'));
      await writeFile(join(runsDir, 'queue', 'dispatch-events.log'), '');
      expect(await defaultDispatchEventsPath(runsDir)).toBe(join(runsDir, 'queue', 'dispatch-events.log'));
    });
  });

  it('rejects an invalid filter before opening a file', async () => {
    await expect(readDispatchEvents({ path: fixture, since: 'yesterday' })).rejects.toThrow('--since');
    await expect(readDispatchEvents({ path: fixture, since: '2026-10-26 18:00:00' })).rejects.toThrow('--since');
  });
});

describe('phm fleet dispatch-events', () => {
  it('routes through cmdFleet to the JSON reader', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['dispatch-events', '--file', fixture, '--since', '2026-10-26T18:05:00Z', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({
      events: [{ kind: 'LANE_HOLD' }, { kind: 'PUBLISH_RETRY_SCHEDULED', at: '2026-10-26T18:06:00.000Z' }],
      malformedLines: 4, source: 'present', path: fixture,
    });
  });

  it('prints records and reports skipped lines without echoing malformed content', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetDispatchEvents(['--file', fixture])).toBe(0);
    expect(output).toHaveBeenCalledTimes(7);
    expect(errors).toHaveBeenCalledWith('Skipped 4 malformed dispatch event line(s).');
    expect(errors.mock.calls.flat().join('\n')).not.toContain('not a record');
  });

  it('prints usage for --help', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['dispatch-events', '--help'])).toBe(0);
    expect(String(output.mock.calls[0]![0])).toMatch(/^Usage: phm fleet dispatch-events/);
  });

  it.each([['--since'], ['--unknown'], ['unexpected'], ['--json', '--json'], ['--since', 'bad']])(
    'rejects invalid arguments %j', async (...args) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await cmdFleetDispatchEvents(args)).not.toBe(0);
    });
});
