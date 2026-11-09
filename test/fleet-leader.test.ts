import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLeader, readFleetLeader } from '../src/cli/fleet-leader.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const event = (minute: string, rc: number) => `2026-11-02 08:${minute}:00 OPUS-LEADER rc=${rc}`;
const now = new Date(2026, 10, 2, 9, 0, 0).getTime();
afterEach(() => vi.restoreAllMocks());

describe('ashlr fleet leader', () => {
  it('reads the matching first line for each failure and calculates the streak and age', async () => {
    const readOutput = vi.fn(async (path: string) => path.includes('11020802') ? 'first reason\nignored' : 'second reason\nignored');
    const report = await readFleetLeader({ readEvents: async () => [event('01', 0), event('02', 1), 'other', event('03', -1)].join('\n'), readOutput, now });
    expect(report).toMatchObject({ failedInRow: 2, lastOkAgeSeconds: 3540, runs: [
      { time: '2026-11-02 08:01:00', status: 'ok', reason: null },
      { status: 'failed', reason: 'first reason' }, { status: 'failed', reason: 'second reason' },
    ] });
    expect(readOutput).toHaveBeenCalledTimes(2);
    expect(readOutput.mock.calls[0]![0]).toMatch(/leader\/opus-run-11020802\.out$/);
  });
  it('limits the event window before selecting the last 12 runs', async () => {
    const lines = [event('00', 0), ...Array.from({ length: 2000 }, (_, i) => i < 1987 ? 'other' : event('01', 1))];
    const report = await readFleetLeader({ readEvents: async () => lines.join('\n') + '\n', readOutput: async () => { throw new Error(); }, now });
    expect(report.runs).toHaveLength(12);
    expect(report.failedInRow).toBe(12);
    expect(report.lastOkAgeSeconds).toBeNull();
    expect(report.runs[0]!.reason).toBeNull();
  });
  it('resets the streak on success and leaves a future success age unknown', async () => {
    const report = await readFleetLeader({ readEvents: async () => [event('01', 1), event('02', 0)].join('\n'), readOutput: async () => '', now: now - 3600000 });
    expect(report.failedInRow).toBe(0);
    expect(report.lastOkAgeSeconds).toBeNull();
  });
  it('prints plain and JSON output, handles invalid input and dispatch errors', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const options = { readEvents: async () => event('01', 1), readOutput: async () => 'problem\nignored', now };
    expect(await cmdFleetLeader([], options)).toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('2026-11-02 08:01:00 failed: problem\nfailed in a row: 1\nlast ok age: unknown'));
    expect(await cmdFleetLeader(['--json'], options)).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ schema: 'fleet.leader.v1', readOnly: true });
    expect(await cmdFleetLeader(['--bad'], options)).toBe(2);
    expect(error).toHaveBeenCalled();
    expect(await cmdFleetLeader(['--json'], { readEvents: async () => { throw new Error('private'); } })).toBe(2);
    expect(log.mock.calls.at(-1)![0]).not.toContain('private');
    expect(await cmdFleetLeader([], { readEvents: async () => '2026-99-99 00:00:00 OPUS-LEADER rc=0' })).toBe(2);
    expect((await FLEET_SUBCOMMAND_LOADERS.leader!()).cmdFleetLeader).toBe(cmdFleetLeader);
  });
});
