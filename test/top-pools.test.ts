import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { projectTopPools } from '../src/core/top-pools.js';
import * as topPools from '../src/core/top-pools.js';
import { cmdTop, renderTopPools } from '../src/cli/top.js';
import { nowMs, seats } from './fixtures/top-pools/capacity.js';

const policy = defaultBudgetPolicy();
for (const seat of seats) policy.seats[seat.seatId] = { seatId: seat.seatId, enabled: true, reservePercent: 20 };
const local = { claude: null, codex: { usedPercent: 40, windowLabel: '5h' } };
const fixture = () => projectTopPools(seats, policy, nowMs, local);
afterEach(() => vi.restoreAllMocks());

describe('top pools', () => {
  it('renders each account as a co-equal lane', () => {
    expect(renderTopPools(fixture())).toMatchSnapshot();
    expect(fixture().pools.map(row => row.scheduling?.admission)).toEqual(['unknown', 'eligible', 'held']);
  });
  it('does not assign local engine usage to missing personal telemetry', () => {
    const snapshot = projectTopPools(null, policy, nowMs, local);
    expect(snapshot.source).toBe('missing');
    expect(snapshot.pools).toEqual([{ poolId: 'codex-personal', engine: 'codex', scheduling: null }]);
    expect(renderTopPools(snapshot)).toMatchSnapshot();
  });
  it('keeps stale, future and expired readings unknown', () => {
    for (const observedAt of [new Date(nowMs - 16 * 60_000).toISOString(), new Date(nowMs + 1).toISOString()]) {
      const snapshot = projectTopPools([{ ...seats[1]!, observedAt }], policy, nowMs, local);
      expect(snapshot.pools[0]!.scheduling?.admission).toBe('unknown');
    }
    expect(projectTopPools(seats, policy, nowMs + 86400_000, local).pools[1]!.scheduling?.admission).toBe('unknown');
  });
  it('--json emits one versioned object with the complete schema and no terminal escapes', async () => {
    vi.spyOn(topPools, 'collectTopPools').mockReturnValue(fixture());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdTop(['--json'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const output = String(log.mock.calls[0]![0]);
    expect(output).not.toContain('\x1b');
    const parsed = JSON.parse(output);
    expect(parsed).toEqual(fixture());
    expect(parsed).toMatchSnapshot();
    expect(Object.keys(parsed).sort()).toEqual(['generatedAt', 'localSubscriptionUsage', 'pools', 'schemaVersion', 'source']);
    expect(parsed.schemaVersion).toBe(1);
    for (const row of parsed.pools) {
      expect(Object.keys(row).sort()).toEqual(['engine', 'poolId', 'scheduling']);
      expect(row.poolId).toEqual(expect.any(String));
      expect(row.engine).toEqual(expect.any(String));
      expect(row.scheduling.headroomPercent === null || typeof row.scheduling.headroomPercent === 'number').toBe(true);
      expect(row.scheduling).toEqual({
        seatId: row.poolId, observedAt: expect.any(String),
        admission: expect.stringMatching(/^(eligible|held|unknown)$/),
        headroomPercent: row.scheduling.headroomPercent,
        reset: expect.objectContaining({ kind: expect.any(String) }),
        opportunity: { kind: expect.any(String), reason: expect.any(String) }, forecast: null,
      });
    }
  });
  it('help and invalid flags do not collect data', async () => {
    const collect = vi.spyOn(topPools, 'collectTopPools');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTop(['--help'])).toBe(0);
    expect(await cmdTop(['--wat'])).toBe(2);
    expect(collect).not.toHaveBeenCalled();
  });
});
