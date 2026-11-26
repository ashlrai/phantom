import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectUsageSpend, spendCountdown, type SpendSnapshot } from '../src/core/usage/spend.js';
import { cmdFleetSpend, spendLine } from '../src/cli/fleet-spend.js';

// Fixture budget block in the dispatchd status shape. All values are fake.
const NOW = Date.parse('2026-11-16T12:00:00Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const measured = (used: number, resetInHours: number, burn: number) =>
  ({ use_it_all: { known: true, stale: false, used_pct: used, reset_at: iso(NOW + resetInHours * HOUR), burn_pct_per_hour: burn } });
const status = (budget: Record<string, unknown>) => ({ schema: 'dispatchd.status.v1', last_tick: iso(NOW), budget });
const FIXTURE = status({
  'codex-personal': measured(65, 100, 0.35),            // 65 + 35 = 100: on pace
  claude: measured(41, 80, 0.6125),                      // 41 + 49 = 90: 10% unused
  zai: measured(103, 50, 1),                             // overage reading: used up
  gemini: { use_it_all: { known: false } },              // no reading
  'claude-api': { gift: { usd_remaining: 112, usd_granted: 112, as_of: iso(NOW - HOUR), expires_at: iso(NOW + 8 * 24 * HOUR) } },
  devin: { gift: { usd_remaining: 40, as_of: iso(NOW - HOUR), expires_at: iso(NOW - HOUR) } },
});
const rows = (raw: unknown = FIXTURE, now = NOW) => projectUsageSpend(raw, now).pools;
const row = (pool: string, raw?: unknown) => rows(raw).find(r => r.pool === pool)!;

describe('fleet spend projection', () => {
  it('on pace: a pool that reaches 100% by reset', () => {
    expect(row('codex-personal')).toMatchObject({ verdict: 'on-pace', status: 'on-pace', summary: 'on pace', usedPercent: 65,
      projectedUsedPercent: 100, projectedUnusedPercent: 0, resetsIn: '4d 4h', unit: 'percent', reason: null });
  });

  it('behind: a pool that would reset with a share unspent', () => {
    const claude = row('claude');
    expect(claude).toMatchObject({ verdict: 'behind', status: 'behind', summary: 'behind: 10% would go unused', usedPercent: 41, resetsIn: '3d 8h' });
    expect(claude.projectedUsedPercent).toBeCloseTo(90);
    expect(claude.projectedUnusedPercent).toBeCloseTo(10);
  });

  it('used up: an overage reading above 100% is measured, not rejected', () => {
    expect(row('zai')).toMatchObject({ verdict: 'used-up', status: 'exhausted', summary: 'used up', usedPercent: 103, projectedUsedPercent: 100 });
  });

  it('unknown: missing, stale and absent readings render unknown, never zero', () => {
    const gemini = row('gemini');
    expect(gemini).toMatchObject({ verdict: 'unknown', status: 'unknown', summary: 'unknown: reading missing', usedPercent: null,
      projectedUsedPercent: null, resetsIn: null });
    expect(rows(FIXTURE, NOW + 121_000).every(r => r.verdict === 'unknown' && r.summary === 'unknown: status missing or stale')).toBe(true);
    expect(rows(null).every(r => r.usedPercent === null && r.projectedUsedPercent === null && r.remainingUsd === null)).toBe(true);
  });

  it('gift pool: shows the balance and expiry, and stays unknown without a spend rate', () => {
    expect(row('claude-api')).toMatchObject({ unit: 'usd', verdict: 'unknown', summary: 'unknown: no spend rate',
      remainingUsd: 112, usedPercent: 0, resetsIn: '8d 0h', projectedUsedPercent: null, projectedUnusedUsd: null });
  });

  it('gift pool: projects unspent USD at expiry once a spend rate is known', () => {
    const gift = (burn: number) => status({ 'claude-api': { gift: { usd_remaining: 112, usd_granted: 112, as_of: iso(NOW),
      expires_at: iso(NOW + 100 * HOUR), usd_burn_per_hour: burn } } });
    expect(row('claude-api', gift(0))).toMatchObject({ verdict: 'behind', summary: 'behind: 112 USD would go unused',
      projectedUnusedUsd: 112, projectedUsedPercent: 0 });
    expect(row('claude-api', gift(2))).toMatchObject({ verdict: 'on-pace', projectedUnusedUsd: 0, projectedUsedPercent: 100 });
  });

  it('gift pool: missing expiry, stale as_of and a spent balance', () => {
    const gift = (g: Record<string, unknown>) => status({ 'claude-api': { gift: g } });
    expect(row('claude-api', gift({ usd_remaining: '30', as_of: iso(NOW) }))).toMatchObject({ verdict: 'unknown',
      summary: 'unknown: expiry date missing', remainingUsd: 30, usedPercent: null });
    expect(row('claude-api', gift({ usd_remaining: 30, as_of: iso(NOW - 25 * HOUR) }))).toMatchObject({ verdict: 'unknown',
      summary: 'unknown: reading stale', remainingUsd: null });
    expect(row('claude-api', gift({ usd_remaining: 30 })).summary).toBe('unknown: reading missing');
    expect(row('claude-api', gift({ usd_remaining: 0, as_of: iso(NOW) })).verdict).toBe('used-up');
  });

  it('expired: a gift past its expiry says expired and drops the balance', () => {
    expect(row('devin')).toMatchObject({ verdict: 'expired', status: 'exhausted', summary: 'expired', remainingUsd: null, resetsIn: null });
  });

  it('sorts behind first, then unknown, expired, on pace, used up', () => {
    expect(rows().map(r => `${r.verdict}:${r.pool}`)).toEqual([
      'behind:claude', 'unknown:claude-api', 'unknown:gemini', 'unknown:local', 'expired:devin', 'on-pace:codex-personal', 'used-up:zai']);
  });

  it('puts the pool that will waste the most first among the behind pools', () => {
    const gift = { gift: { usd_remaining: 60, as_of: iso(NOW), expires_at: iso(NOW + 300 * HOUR), usd_burn_per_hour: 0.1 } };
    const order = rows(status({ claude: measured(41, 80, 0.6125), zai: measured(10, 20, 1), 'codex-personal': measured(50, 5, 0), 'claude-api': gift }))
      .filter(r => r.status === 'behind').map(r => `${r.pool}:${Math.round(r.projectedUnusedPercent ?? r.projectedUnusedUsd! / r.remainingUsd! * 100)}`);
    // zai resets soonest after codex-personal but wastes the most, so it leads; the ungranted gift ranks by its balance share.
    expect(order).toEqual(['zai:70', 'codex-personal:50', 'claude-api:50', 'claude:10']);
  });

  it('carries a schema, a version and one plain sentence about the worst pool', () => {
    const snapshot = projectUsageSpend(FIXTURE, NOW);
    expect(snapshot).toMatchObject({ schema: 'usage.spend.v1', v: 1, asOf: iso(NOW) });
    expect(Object.keys(snapshot)).toEqual(['schema', 'v', 'asOf', 'headline', 'pools']);
    expect(snapshot.headline).toBe('claude: 59% left, resets in 3d 8h, 10% would go unused.');
  });

  it('headline: an expiring gift with zero spend says nothing is using it', () => {
    const idle = status({ claude: measured(41, 80, 0.6125), 'claude-api': { gift: { usd_remaining: 112, usd_granted: 112, as_of: iso(NOW),
      expires_at: iso(NOW + 150 * HOUR), usd_burn_per_hour: 0 } } });
    const snapshot = projectUsageSpend(idle, NOW);
    expect(snapshot.pools[0]).toMatchObject({ pool: 'claude-api', status: 'behind', usedPercent: 0, burnPerHour: 0,
      projectedUnusedUsd: 112, projectedUnusedPercent: 100, hoursLeft: 150 });
    expect(snapshot.headline).toBe('claude-api gift: 112 USD left, expires in 6d 6h, nothing is using it; 1 more behind.');
  });

  it('headline: says unknown when nothing is measured and never names a number', () => {
    expect(projectUsageSpend(null, NOW).headline).toBe('Unknown: the dispatcher status is missing or stale.');
    expect(projectUsageSpend(status({}), NOW).headline).toBe('Unknown: no pool has a complete reading.');
    expect(projectUsageSpend(status({ 'codex-personal': measured(65, 100, 0.35), zai: measured(103, 50, 1) }), NOW).headline)
      .toBe('Nothing measured will go unused; 5 unknown.');
  });

  it('counts down in days and hours, then hours and minutes', () => {
    expect(spendCountdown(50.5)).toBe('2d 2h');
    expect(spendCountdown(3.25)).toBe('3h 15m');
    expect(spendCountdown(0.5)).toBe('30m');
    expect(spendCountdown(0)).toBeNull();
    expect(spendCountdown(null)).toBeNull();
  });
});

describe('phm spend', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const snapshot: SpendSnapshot = projectUsageSpend(FIXTURE, NOW);
  const run = async (args: string[]) => {
    const out: string[] = []; const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
    vi.spyOn(console, 'error').mockImplementation((line: string) => { err.push(line); });
    const code = await cmdFleetSpend(args, async () => snapshot);
    return { code, out, err };
  };

  it('prints the sentence, then one plain line per pool, behind first', async () => {
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toHaveLength(snapshot.pools.length + 1);
    expect(out[0]).toBe(snapshot.headline);
    expect(out[1]).toBe('claude: behind (will waste) · 41% used · burn 0.61%/h · 10% unused at reset · resets in 3d 8h (2026-11-19T20:00:00.000Z)');
    expect(out).toContain('codex-personal: on-pace · 65% used · burn 0.35%/h · 0% unused at reset · resets in 4d 4h (2026-11-20T16:00:00.000Z)');
    expect(out).toContain('gemini: unknown (reading missing)');
    expect(out).toContain('claude-api gift: unknown (no spend rate) · 112 USD left (0% used) · burn unknown · unknown unused at expiry · expires in 8d 0h (2026-11-24T12:00:00.000Z)');
    expect(out).toContain('devin gift: exhausted (expired)');
  });

  it('prints the typed snapshot as JSON', async () => {
    const { code, out } = await run(['--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual(snapshot);
  });

  it('rejects unknown flags and prints help', async () => {
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['--json', 'extra'])).code).toBe(2);
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out[0]).toMatch(/^Usage: phm spend \[--json\]\n/);
    expect(help.out[0]).toContain('usage.spend.v1');
  });

  it('shares the line format with the snapshot rows', () => {
    expect(spendLine(snapshot.pools.find(r => r.pool === 'zai')!)).toBe('zai: exhausted · 103% used · burn 1%/h · 0% unused at reset · resets in 2d 2h (2026-11-18T14:00:00.000Z)');
  });
});
