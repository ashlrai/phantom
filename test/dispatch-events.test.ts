import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchTimestampMs, parseDispatchEventLine, readDispatchEvents } from '../src/core/fabric/dispatch-events.js';
import { cmdFleetEvents } from '../src/cli/fleet-events.js';
import { cmdFleet } from '../src/cli/fleet.js';

const fixture = fileURLToPath(new URL('./fixtures/dispatch-events/events.txt', import.meta.url));
afterEach(() => vi.restoreAllMocks());

describe('dispatch event parser', () => {
  it.each(['RESTOCK', 'LAUNCH_FAILED', 'PUBLISH_STARTED', 'PUBLISH_FAILED', 'PUBLISH_SUCCESS', 'LANE_HOLD', 'PUBLISH_RETRY_SCHEDULED'])('parses the %s fixture', async (kind) => {
    const line = (await readFile(fixture, 'utf8')).split('\n').find((line) => line.includes(` ${kind} `))!;
    const parsed = parseDispatchEventLine(line);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.event.kind).toBe(kind);
      expect(parsed.event.message).toContain('=');
      expect(dispatchTimestampMs(parsed.event.timestamp)).not.toBeNull();
    }
  });

  it.each([
    '', 'garbage', '2026-10-26 RESTOCK x', '2026-02-30T00:00:00Z RESTOCK x',
    '2026-10-26T24:00:00Z RESTOCK x', '2026-10-26T00:00:00 RESTOCK x',
    '2026-10-26T00:00:00Z PUBLISH_ x', '2026-10-26T00:00:00Z OTHER x',
    '2026-10-26T00:00:00Z RESTOCK x\nsecond line',
  ])('rejects malformed record %j', (line) => {
    expect(parseDispatchEventLine(line).ok).toBe(false);
  });

  it('keeps payload text inert and supports an empty payload and CRLF', () => {
    expect(parseDispatchEventLine('2026-10-26T00:00:00Z RESTOCK\r')).toEqual({
      ok: true, event: { timestamp: '2026-10-26T00:00:00Z', kind: 'RESTOCK', message: '' },
    });
    const result = parseDispatchEventLine('2026-10-26T00:00:00Z LANE_HOLD reason=$(false)');
    expect(result).toMatchObject({ ok: true, event: { message: 'reason=$(false)' } });
  });
});

describe('dispatch event reader and CLI', () => {
  it('reads every kind and counts malformed and blank fixture lines', async () => {
    const report = await readDispatchEvents({ path: fixture });
    expect(report.events).toHaveLength(7);
    expect(report).toMatchObject({ source: 'present', malformedLines: 4, emptyLines: 1 });
  });

  it('filters inclusively by instant across timezone offsets', async () => {
    const report = await readDispatchEvents({ path: fixture, since: '2026-10-26T18:04:00Z' });
    expect(report.events.map((event) => event.kind)).toEqual(['PUBLISH_SUCCESS', 'LANE_HOLD', 'PUBLISH_RETRY_SCHEDULED']);
  });

  it('distinguishes a missing log from an unreadable one and accepts a final line without newline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dispatch-events-'));
    try {
      const path = join(directory, 'events.log');
      expect(await readDispatchEvents({ path })).toMatchObject({ source: 'missing', events: [] });
      await expect(readDispatchEvents({ path: directory })).rejects.toThrow();
      await writeFile(path, '2026-10-26T18:00:00Z RESTOCK count=1\r\n2026-10-26T18:01:00Z LANE_HOLD');
      expect((await readDispatchEvents({ path })).events).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an invalid filter before opening a file', async () => {
    await expect(readDispatchEvents({ path: fixture, since: 'yesterday' })).rejects.toThrow('--since');
  });

  it('routes fleet events to the JSON reader', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['events', '--file', fixture, '--since', '2026-10-26T18:05:00Z', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ events: [{ kind: 'LANE_HOLD' }, { kind: 'PUBLISH_RETRY_SCHEDULED' }], malformedLines: 4 });
  });

  it('preserves fleet help and rejects invalid events options through the dispatcher', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleet(['events', '--help'])).toBe(0);
    expect(output.mock.calls.some(([line]) => String(line).includes('fleet events'))).toBe(true);
    expect(await cmdFleet(['events', '--json', '--json'])).toBe(2);
    expect(await cmdFleet(['events', '--file'])).toBe(2);
  });

  it('prints records and reports skipped lines without echoing malformed content', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetEvents(['--file', fixture])).toBe(0);
    expect(output).toHaveBeenCalledTimes(7);
    expect(errors).toHaveBeenCalledWith('Skipped 4 malformed dispatch event line(s).');
  });

  it.each([['--since'], ['--unknown'], ['unexpected'], ['--json', '--json'], ['--since', 'bad']])('rejects invalid CLI arguments %j', async (...args) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetEvents(args)).not.toBe(0);
  });
});
