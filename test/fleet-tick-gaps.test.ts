import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetTickGaps, readFleetTickGaps } from '../src/cli/fleet-tick-gaps.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = new Date(2026, 10, 2, 12).getTime();
const row = (time: string) => `2026-11-02 ${time} TICK rc=0`;
const options = (...rows: string[]) => ({ now, readEvents: async () => rows.join('\r\n') });
afterEach(() => vi.restoreAllMocks());

describe('fleet tick-gaps', () => {
  it('reports full gaps ending inside the window, their preceding lines, count and longest', async () => {
    const report = await readFleetTickGaps(options(row('04:00:00'), row('05:00:00'),
      row('06:00:00'), row('06:05:00'), row('06:10:01'), row('08:00:00')));
    expect(report.count).toBe(3);
    expect(report.gaps.map(gap => gap.lengthSeconds)).toEqual([3600, 301, 6599]);
    expect(report.gaps[0]).toEqual({ start: new Date(2026, 10, 2, 5).toISOString(),
      end: new Date(2026, 10, 2, 6).toISOString(), lengthSeconds: 3600, lineBefore: row('05:00:00') });
    expect(report.longestGap).toEqual(report.gaps[2]);
  });
  it('does not infer leading or trailing gaps, including empty and single-line logs', async () => {
    for (const rows of [[], [row('07:00:00')], [row('05:00:00'), row('05:30:00')]]) {
      expect(await readFleetTickGaps(options(...rows))).toMatchObject({ source: 'read', count: 0, longestGap: null });
    }
  });
  it('breaks adjacency on malformed, impossible, future and backwards timestamps', async () => {
    for (const middle of ['bad', '2026-02-30 09:00:00 TICK', row('13:00:00'), row('06:00:00')]) {
      expect(await readFleetTickGaps(options(row('07:00:00'), middle, row('09:00:00')))).toMatchObject({ count: 0 });
    }
    expect((await readFleetTickGaps(options(row('07:00:00'), '', row('07:00:00'), row('07:05:00')))).count).toBe(0);
  });
  it('reads the canonical path and keeps missing or failed reads unknown without leaking errors', async () => {
    const readEvents = vi.fn(async () => { throw new Error('private failure'); });
    expect(await readFleetTickGaps({ now, readEvents })).toMatchObject({ source: 'unknown', count: null });
    expect(readEvents).toHaveBeenCalledWith(expect.stringMatching(/\.ashlr-runs\/queue\/dispatch-events\.log$/));
    expect(await readFleetTickGaps({ now, readEvents: async () => null })).toMatchObject({ source: 'unknown' });
  });
  it('prints typed JSON and plain words with source-aware exits', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetTickGaps(['--json'], options(row('07:00:00'), row('07:06:00')))).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ schema: 'fleet.tick-gaps.v1', count: 1 });
    expect(await cmdFleetTickGaps([], options(row('07:00:00'), row('07:06:00')))).toBe(0);
    expect(log.mock.calls[1]![0]).toContain(`Longest gap: 360 seconds`);
    expect(log.mock.calls[1]![0]).toContain(`Line before: ${row('07:00:00')}`);
    expect(await cmdFleetTickGaps([], { readEvents: async () => null })).toBe(1);
    expect(log.mock.calls[2]![0]).toContain('Longest gap: unknown');
  });
  it('handles help and invalid arguments without reading and loads through the fleet registry', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const readEvents = vi.fn(async () => '');
    expect(await cmdFleetTickGaps(['--help'], { readEvents })).toBe(0);
    expect(await cmdFleetTickGaps(['--bad'], { readEvents })).toBe(2);
    expect(await cmdFleetTickGaps(['--json', '--json'], { readEvents })).toBe(2);
    expect(readEvents).not.toHaveBeenCalled();
    expect((await FLEET_SUBCOMMAND_LOADERS['tick-gaps']!()).cmdFleetTickGaps).toBe(cmdFleetTickGaps);
  });
});
