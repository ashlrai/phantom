import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPools } from '../src/cli/fleet-pools.js';
import { projectPoolRunway } from '../src/core/usage/runway-read.js';
import { projectUsagePace } from '../src/core/usage/pace.js';
import { planPoolShares, poolShareSnapshot, POOL_SHARE_STATES, type PoolShareInput } from '../src/core/usage/runway.js';

const pool = (name: string, usedPercent: number | null, burnPerHour: number | null, hoursToReset: number | null): PoolShareInput =>
  ({ pool: name, usedPercent, burnPerHour, hoursToReset });
const one = (input: PoolShareInput) => planPoolShares([input])[0]!;

describe('planPoolShares', () => {
  it('starving: runs dry before 80% of the time to reset (the Nov 18 personal Codex reading)', () => {
    expect(one(pool('codex-personal', 97, 1, 72))).toMatchObject({
      pool: 'codex-personal', state: 'starving', runway_hours: 3, hours_to_reset: 72, suggested_share: 0,
      line: 'Codex personal: 3% left, runs dry in 3 h, resets in 72 h, top-priority work only' });
    // Used up (or in overage) is starving with no runway at all.
    expect(one(pool('zai', 104, 0, 10))).toMatchObject({ state: 'starving', runway_hours: 0, suggested_share: 0 });
  });

  it('wasting: projected use at reset under 90% (the Nov 18 Claude reading)', () => {
    expect(one(pool('claude', 1, 0.1, 50))).toMatchObject({
      state: 'wasting', runway_hours: 990, hours_to_reset: 50, projected_percent_at_reset: 6, suggested_share: 1, rank: 1,
      line: 'Claude: 99% left, resets in 50 h, send work here' });
  });

  it('on_pace: lasts at least 80% of the window and lands at 90% or more', () => {
    // 50 left at 1/h = 50 h runway vs 55 h to reset (>= 44 h); projected 100.
    expect(one(pool('gemini', 50, 1, 55))).toMatchObject({ state: 'on_pace', runway_hours: 50, projected_percent_at_reset: 100,
      line: 'Gemini: 50% left, resets in 55 h, on pace, normal work' });
    // The 80% edge is not starving.
    expect(one(pool('gemini', 60, 1, 50)).state).toBe('on_pace');
    expect(one(pool('gemini', 60, 1.01, 50)).state).toBe('starving');
  });

  it('zero burn: never runs dry, so runway is null and the state follows projected use', () => {
    expect(one(pool('zai', 20, 0, 100))).toMatchObject({ state: 'wasting', runway_hours: null, projected_percent_at_reset: 20 });
    expect(one(pool('zai', 95, 0, 100))).toMatchObject({ state: 'on_pace', runway_hours: null });
  });

  it('unknown: any missing input, never guessed', () => {
    for (const input of [pool('a', null, 1, 10), pool('a', 10, null, 10), pool('a', 10, 1, null), pool('a', Number.NaN, 1, 10), pool('a', 10, -1, 10)]) {
      expect(one(input)).toMatchObject({ state: 'unknown', suggested_share: null, runway_hours: null, projected_percent_at_reset: null });
    }
    expect(one(pool('gemini', null, null, null)).line).toBe('Gemini: unknown (no usage reading)');
    expect(one(pool('gemini', 10, null, 5)).reason).toBe('no burn rate yet');
  });

  it('a reset in the past is unknown until a new reading lands', () => {
    for (const hours of [0, -3]) {
      expect(one(pool('claude', 40, 1, hours))).toMatchObject({ state: 'unknown', hours_to_reset: hours, suggested_share: null,
        reason: 'reset already passed; waiting for a new reading' });
    }
  });

  it('ranks wasting first by unused room, then on pace, then starving, then unknown; shares sum to 1', () => {
    const rows = planPoolShares([pool('codex-personal', 97, 1, 72), pool('gemini', null, null, null), pool('zai', 50, 1, 55),
      pool('claude', 1, 0.1, 50), pool('grok', 40, 0.5, 20)]);
    expect(rows.map(row => [row.pool, row.state, row.rank])).toEqual([
      ['claude', 'wasting', 1], ['grok', 'wasting', 2], ['zai', 'on_pace', 3], ['codex-personal', 'starving', 4], ['gemini', 'unknown', 5]]);
    // claude leaves 94 unused, grok 50, zai 0: shares follow that room.
    expect(rows.map(row => row.suggested_share)).toEqual([0.65, 0.35, 0, 0, null]);
    expect(rows.every(row => POOL_SHARE_STATES.includes(row.state))).toBe(true);
  });

  it('splits evenly across on-pace pools when nobody has spare room; next_pool is null when none can take work', () => {
    expect(planPoolShares([pool('a', 50, 1, 55), pool('b', 60, 1, 45)]).map(row => row.suggested_share)).toEqual([0.5, 0.5]);
    expect(poolShareSnapshot([pool('a', 97, 1, 72), pool('b', null, null, null)], null).next_pool).toBeNull();
    expect(poolShareSnapshot([pool('a', 97, 1, 72), pool('b', 1, 0.1, 50)], null).next_pool).toBe('b');
  });
});

describe('usage pace snapshot carries the shares (resources API payload)', () => {
  const now = Date.parse('2026-11-18T16:00:00Z');

  it('shares spend-down facts between CLI and desktop/phone, including gifts and all budget pools', async () => {
    const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
    const measured = (used: number, burn: number, h: number) => ({ use_it_all: { known: true, stale: false, used_pct: used, burn_pct_per_hour: burn, reset_at: at(h) } });
    const raw = { schema: 'dispatchd.status.v1', last_tick: at(0), budget: {
      'codex-personal': measured(50, 1, 50), 'codex-cmp': measured(50, 1, 98), claude: measured(50, 1, 20),
      zai: { use_it_all: { known: true, stale: true } }, custom: {},
      'claude-api': { gift: { usd_remaining: 50, usd_granted: 100, usd_burn_per_hour: 1, as_of: at(0), expires_at: at(20) } },
    } };
    const shares = projectUsagePace(raw, now).shares;
    const row = (pool: string) => shares.pools.find(r => r.pool === pool)!;
    expect(row('codex-personal').verdict).toBe('on pace');
    expect(row('codex-cmp')).toBeUndefined();
    expect(row('claude')).toMatchObject({ verdict: 'will waste 30%', used_percent: 50, burn_pct_per_hour: 1, hours_to_reset: 20, reset_at: at(20), projected_percent_at_reset: 70 });
    expect(row('claude-api')).toMatchObject({ unit: 'usd', remaining_usd: 50, used_percent: 50, burn_pct_per_hour: 1, verdict: 'will waste 30%' });
    expect(row('zai')).toMatchObject({ verdict: 'unknown: reading stale', used_percent: null });
    expect(row('custom')).toMatchObject({ verdict: 'unknown: no reading', projected_percent_at_reset: null });
    expect(row('claude-api')).toMatchObject({ unit: 'usd', used_percent: 50, burn_pct_per_hour: 1, remaining_usd: 50, projected_percent_at_reset: 70, reset_at: at(20) });
    expect(projectPoolRunway(raw, now).shares).toEqual(shares);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await cmdFleetPools(['--json'], { read: async () => ({ shares }) });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(shares);
    log.mockRestore();
    expect(projectUsagePace(raw, now + 120_001).shares.pools.every(r => r.used_percent === null && r.burn_pct_per_hour === null && r.reset_at === null)).toBe(true);
  });

  it('reads fresh known readings only; stale and missing pools stay unknown', () => {
    const { shares } = projectUsagePace({ schema: 'dispatchd.status.v1', last_tick: '2026-11-18T16:00:00Z', budget: {
      claude: { use_it_all: { known: true, stale: false, used_pct: 1, burn_pct_per_hour: 0.1, reset_at: '2026-11-20T18:00:00Z' } },
      'codex-personal': { use_it_all: { known: true, stale: true, used_pct: 97, burn_pct_per_hour: 1, hours_to_reset: 72 } },
    } }, now);
    expect(shares.next_pool).toBe('claude');
    expect(shares.pools.find(row => row.pool === 'claude')).toMatchObject({ state: 'wasting', hours_to_reset: 50 });
    expect(shares.pools.find(row => row.pool === 'codex-personal')).toMatchObject({ state: 'unknown' });
    expect(projectUsagePace(null, now).shares.pools.every(row => row.state === 'unknown')).toBe(true);
  });
});

describe('phm fleet pools', () => {
  afterEach(() => vi.restoreAllMocks());
  const capture = () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { out.push(String(line)); });
    return out;
  };

  it('--json prints fleet.pools.v1 with one typed row per pool, read from <runs-dir>/queue/status.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-pools-'));
    try {
      await mkdir(join(root, 'queue'));
      await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({ schema: 'dispatchd.status.v1', last_tick: new Date().toISOString(), budget: {
        claude: { use_it_all: { known: true, stale: false, used_pct: 1, burn_pct_per_hour: 0.1, hours_to_reset: 50 } },
        'codex-personal': { use_it_all: { known: true, stale: false, used_pct: 97, burn_pct_per_hour: 1, hours_to_reset: 72 } },
      } }));
      const out = capture();
      expect(await cmdFleetPools(['--json', '--runs-dir', root])).toBe(0);
      const parsed = JSON.parse(out.join('\n')) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(['asOf', 'next_pool', 'pools', 'schema']);
      expect(parsed).toMatchObject({ schema: 'fleet.pools.v1', next_pool: 'claude', asOf: expect.any(String) });
      const pools = parsed.pools as Record<string, unknown>[];
      expect(pools.map(row => row.pool)).toEqual(['claude', 'codex-personal', 'claude-api', 'gemini', 'zai']);
      for (const row of pools) {
        expect(Object.keys(row).sort()).toEqual(['burn_pct_per_hour', 'hours_to_reset', 'line', 'pool', 'projected_percent_at_reset', 'rank', 'reason',
          'remaining_usd', 'reset_at', 'runway_hours', 'state', 'suggested_share', 'unit', 'used_percent', 'verdict']);
        for (const key of ['runway_hours', 'hours_to_reset', 'suggested_share', 'used_percent', 'projected_percent_at_reset']) {
          expect(row[key] === null || typeof row[key] === 'number').toBe(true);
        }
      }
      expect(pools.map(row => row.state)).toEqual(['wasting', 'starving', 'unknown', 'unknown', 'unknown']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('prints plain lines, says unknown when the status is missing, and refuses bad flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-pools-'));
    try {
      const out = capture();
      expect(await cmdFleetPools(['--runs-dir', root])).toBe(0);
      expect(out[0]).toBe('Next job: unknown (no pool is known to have room)');
      expect(out.slice(1)).toHaveLength(5);
      expect(out.slice(1).every(line => line.includes('unknown: status missing or stale') && !line.includes('0%'))).toBe(true);
      expect(await cmdFleetPools(['--runs-dir', 'relative'])).toBe(2);
      expect(await cmdFleetPools(['--bogus'])).toBe(2);
      expect(await cmdFleetPools(['--help'])).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
