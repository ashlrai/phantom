import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLeaderHealth, readFleetLeaderHealth } from '../src/cli/fleet-leader-health.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = new Date(2026, 10, 2, 12).getTime();
const row = (hour: number, event: string) => `2026-11-02 ${String(hour).padStart(2, '0')}:00:00 ${event}`;
const options = (...rows: string[]) => ({ now, readEvents: async () => rows.join('\n') });
afterEach(() => vi.restoreAllMocks());

describe('fleet leader-health', () => {
  it('counts the Opus tail despite unrelated events and tracks success and positive bets separately', async () => {
    const report = await readFleetLeaderHealth(options(row(8, 'OPUS-LEADER rc=0'),
      row(9, 'OPUS-LEADER rc=1'), row(9, 'LEADER bets=2'), row(10, 'OTHER rc=0'),
      row(10, 'OPUS-LEADER rc=2'), row(11, 'LEADER bets=0'), row(11, 'OPUS-LEADER rc=-1')));
    expect(report).toEqual({ schema: 'fleet.leader-health.v1', source: 'read',
      consecutiveFailures: 3, hoursSinceLastSuccess: 4, lastBetAt: new Date(2026, 10, 2, 9).toISOString() });
  });
  it('resets failures on success and reports the latest positive bet', async () => {
    const report = await readFleetLeaderHealth(options(row(8, 'OPUS-LEADER rc=1'),
      row(9, 'LEADER bets=1'), row(10, 'OPUS-LEADER rc=0'), row(11, 'LEADER bets=3')));
    expect(report.consecutiveFailures).toBe(0);
    expect(report.hoursSinceLastSuccess).toBe(2);
    expect(report.lastBetAt).toBe(new Date(2026, 10, 2, 11).toISOString());
  });
  it.each([null, ''])('leaves absent evidence unknown (%s)', async text => {
    expect(await readFleetLeaderHealth({ now, readEvents: async () => text })).toMatchObject({
      consecutiveFailures: null, hoursSinceLastSuccess: null, lastBetAt: null });
  });
  it('catches unreadable files without exposing their errors and uses the canonical path', async () => {
    const reader = vi.fn(async () => { throw new Error('private text'); });
    expect(await readFleetLeaderHealth({ readEvents: reader })).toMatchObject({ source: 'unknown', consecutiveFailures: null });
    expect(reader.mock.calls[0]).toEqual([expect.stringMatching(/\.ashlr-runs\/queue\/dispatch-events\.log$/)]);
  });
  it('ignores malformed dates, future events, wrong kinds and misleading fields', async () => {
    expect(await readFleetLeaderHealth(options('bad OPUS-LEADER rc=0',
      '2026-99-99 00:00:00 OPUS-LEADER rc=0', row(13, 'OPUS-LEADER rc=0'),
      row(9, 'LEADER otherbets=2'), row(10, 'OPUS-LEADER otherrc=0')))).toMatchObject({
      consecutiveFailures: null, hoursSinceLastSuccess: null, lastBetAt: null });
  });
  it.each([0, 1, 2, 3, 4])('returns the health exit for %i failures and emits typed JSON', async failures => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLeaderHealth(['--json'], options(row(7, 'OPUS-LEADER rc=0'),
      ...Array.from({ length: failures }, () => row(8, 'OPUS-LEADER rc=1'))))).toBe(failures >= 3 ? 1 : 0);
    expect(JSON.parse(log.mock.calls[0]![0] as string).consecutiveFailures).toBe(failures);
  });
  it('prints unknown in plain words and handles help and bad arguments without reading', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const readEvents = vi.fn(async () => null);
    expect(await cmdFleetLeaderHealth([], { readEvents })).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('Leader failures in a row: unknown');
    readEvents.mockClear();
    expect(await cmdFleetLeaderHealth(['--help'], { readEvents })).toBe(0);
    expect(await cmdFleetLeaderHealth(['--bad'], { readEvents })).toBe(2);
    expect(await cmdFleetLeaderHealth(['--json', '--json'], { readEvents })).toBe(2);
    expect(readEvents).not.toHaveBeenCalled();
  });
  it('is available through the generated fleet registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['leader-health']!()).cmdFleetLeaderHealth).toBe(cmdFleetLeaderHealth);
  });
});
