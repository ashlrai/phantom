import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSupply, fleetSupply, formatSupply } from '../src/cli/fleet-supply.js';

const now = Date.parse('2026-11-02T12:30:00Z');
const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
const row = (job: string, event: string, h = 1, extra = {}) => JSON.stringify({ job, event, ts: hoursAgo(h), ...extra });
const reader = (lines: string[]) => async () => lines.join('\n');
const logs = () => vi.spyOn(console, 'log').mockImplementation(() => {});

afterEach(() => vi.restoreAllMocks());

describe('fleetSupply', () => {
  it('counts each kind per batch and hour', async () => {
    const r = await fleetSupply(reader([
      row('RQ-X-FILL01', 'launch', 1), row('RQ-X-FILL02', 'launch', 1), row('RQ-X-FILL03', 'launch', 3),
      row('RQ-X-FILL01', 'skipped_empty', 1), row('RQ-X-FILL02', 'precheck_skip', 3),
      row('RQ-X-FILL01', 'publish', 1, { url: 'https://github.com/o/r/pull/1', class: 'work' }),
      row('RQ-X-FILL01', 'publish', 1, { url: 'https://github.com/o/r/pull/2' }),
      row('RQ-X-FILL01', 'outcome', 0.2, { state: 'MERGED' }),
      row('RQ-X-FILL01', 'outcome', 1, { state: 'CLOSED' }),
      row('RQ-X-FILL01', 'finish', 1),
      row('RQ-Y-OTHER01', 'launch', 1),
    ]), now);
    expect(r.known).toBe(true);
    const batches = r.batches as Exclude<typeof r.batches, 'unknown'>;
    expect(batches.map(b => b.batch)).toEqual(['RQ-X-FILL', 'RQ-Y-OTHER']);
    expect(batches[0]!.total).toEqual({ launch: 3, skipped_empty: 1, precheck_skip: 1, pr_opened: 1, merged: 1 });
    expect(batches[0]!.hours.map(h => h.hour)).toEqual(['2026-11-02T09:00:00.000Z', '2026-11-02T11:00:00.000Z', '2026-11-02T12:00:00.000Z']);
    expect(batches[0]!.hours[1]).toMatchObject({ launch: 2, skipped_empty: 1, pr_opened: 1, merged: 0 });
  });

  it('ignores old, future, undated, malformed and non-object rows', async () => {
    const r = await fleetSupply(reader([
      row('RQ-X-A01', 'launch', 25), row('RQ-X-A02', 'launch', -1), JSON.stringify({ job: 'RQ-X-A03', event: 'launch' }),
      'not json', '[]', 'null', '', JSON.stringify({ event: 'launch', ts: hoursAgo(1) }),
    ]), now);
    expect(r).toMatchObject({ known: true, batches: [] });
  });

  it('reports unknown, never zero, when the file cannot be read', async () => {
    for (const read of [async () => null, async () => { throw new Error('EACCES'); }]) {
      const r = await fleetSupply(read, now);
      expect(r).toMatchObject({ known: false, batches: 'unknown' });
      expect(formatSupply(r)).toBe('unknown (metrics unreadable)');
    }
  });
});

describe('formatSupply', () => {
  it('prints one plain line per batch', async () => {
    const r = await fleetSupply(reader([row('RQ-X-A01', 'launch'), row('RQ-X-B01', 'skipped_empty'), row('RQ-X-B02', 'skipped_empty')]), now);
    expect(formatSupply(r).split('\n')).toEqual([
      'RQ-X-A: 1 launched, 0 skipped empty, 0 precheck skipped, 0 PRs opened, 0 merged',
      'RQ-X-B: 0 launched, 2 skipped empty, 0 precheck skipped, 0 PRs opened, 0 merged',
    ]);
  });

  it('says so when a readable file has nothing in the window', async () => {
    expect(formatSupply(await fleetSupply(reader([]), now))).toBe('no batch activity in the last 24 hours');
  });
});

describe('cmdFleetSupply', () => {
  it('prints json and exits 0', async () => {
    const log = logs();
    expect(await cmdFleetSupply(['--json'], reader([row('RQ-X-A01', 'launch')]), now)).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ schema: 'fleet.supply.v1', known: true, window_hours: 24 });
  });

  it('prints unknown for an unread file in json and text', async () => {
    const log = logs();
    await cmdFleetSupply(['--json'], async () => null, now);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ known: false, batches: 'unknown' });
    await cmdFleetSupply([], async () => null, now);
    expect(log.mock.calls[1]![0]).toBe('unknown (metrics unreadable)');
  });

  it('prints help and rejects bad arguments with 2', async () => {
    const log = logs();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetSupply(['--help'])).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('Usage: ashlr fleet supply');
    for (const bad of [['--bogus'], ['--json', '--json'], ['x']]) expect(await cmdFleetSupply(bad, reader([]), now)).toBe(2);
    expect(err).toHaveBeenCalled();
  });
});
