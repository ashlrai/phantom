import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLEET_USAGE_SCHEMA, readFleetUsage, type FleetUsageLane } from '../src/core/resources/fleet-usage.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const HOUR = 3_600_000;
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-usage-')); mkdirSync(join(root, 'queue')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(name: string, body: unknown, ageMs = 0): void {
  const p = join(root, 'queue', name);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  const t = new Date(NOW - ageMs);
  utimesSync(p, t, t);
}
async function lanes(): Promise<FleetUsageLane[]> {
  return (await readFleetUsage({ runsDir: root, now: () => NOW })).lanes;
}
const pick = (all: FleetUsageLane[], lane: string, window?: string) =>
  all.find(l => l.lane === lane && (window === undefined || l.window === window))!;

const status = {
  schema: 'dispatchd.status.v1', last_tick: new Date(NOW - 60_000).toISOString(),
  lanes: {
    claude: { running: 2, target: 3, ceiling: 4, held: false, queued: 5 },
    'codex-personal': { running: 0, target: 1, ceiling: 2, held: true, queued: 0 },
    zai: { running: 1, target: 2, ceiling: 3, held: false, queued: 7 },
    'claude-api': { running: 0, target: 0, ceiling: 1, held: true, queued: 0 },
  },
  budget: {
    claude: { weekly_used_pct: 40, reset_at: new Date(NOW + 50 * HOUR).toISOString(), burn_per_hour: 0.5, tokens_per_hour_6h: 1000 },
    'codex-personal': { weekly_used_pct: 10, reset_at: new Date(NOW + 100 * HOUR).toISOString(), burn_per_hour: 0.1 },
    'claude-api': { credits_remaining: 80, reset_at: new Date(NOW + 10 * HOUR).toISOString(), burn_per_hour: 1 },
  },
};

describe('fleet-usage.v1', () => {
  it('reports every lane unknown without throwing when all files are missing', async () => {
    const out = await readFleetUsage({ runsDir: join(root, 'nope'), now: () => NOW });
    expect(out.schema).toBe(FLEET_USAGE_SCHEMA);
    const byLane = new Set(out.lanes.map(l => l.lane));
    expect(byLane).toEqual(new Set(['zai', 'gemini']));
    for (const l of out.lanes) {
      expect(l).toMatchObject({ known: false, used: null, remaining: null, stale: false, waste_risk: 'low' });
    }
    expect(out.lanes.filter(l => l.lane === 'zai').map(l => l.limit)).toEqual([2000, 10000]);
  });

  it('normalizes percent lanes from status.json with counts and projection', async () => {
    put('status.json', status);
    const all = await lanes();
    const claude = pick(all, 'claude');
    expect(claude).toMatchObject({
      provider: 'anthropic', known: true, quota_unit: 'percent', used: 40, limit: 100, remaining: 60, window: 'weekly',
      running: 2, target: 3, ceiling: 4, held: false, queued: 5, burn_per_hour: 0.5, overage_costs_money: false,
      source: 'queue/status.json', stale: false, seconds_to_reset: 50 * 3600,
    });
    expect(claude.projected_used_at_reset).toBe(65);
    expect(claude.projected_unused_at_reset).toBe(35);
    expect(claude.waste_risk).toBe('medium');
    const codex = pick(all, 'codex-personal');
    expect(codex).toMatchObject({ provider: 'openai', held: true, projected_used_at_reset: 20, waste_risk: 'high' });
  });

  it('treats claude-api as metered usd credits that cost money', async () => {
    put('status.json', status);
    const api = pick(await lanes(), 'claude-api');
    expect(api).toMatchObject({ quota_unit: 'usd', window: 'credits', remaining: 80, overage_costs_money: true, used: null });
    expect(api.projected_used_at_reset).toBe(10);
    expect(api.projected_unused_at_reset).toBe(70);
  });

  it('marks claude-api unknown when status.json lacks it', async () => {
    put('status.json', { last_tick: new Date(NOW).toISOString(), lanes: {}, budget: {} });
    const api = pick(await lanes(), 'claude-api');
    expect(api).toMatchObject({ known: false, overage_costs_money: true, remaining: null });
  });

  it('marks status lanes stale when last_tick is older than 24h, using mtime when absent', async () => {
    put('status.json', { ...status, last_tick: new Date(NOW - 25 * HOUR).toISOString() });
    expect(pick(await lanes(), 'claude').stale).toBe(true);
    const { last_tick: _drop, ...noTick } = status;
    put('status.json', noTick, 30 * HOUR);
    expect(pick(await lanes(), 'claude').stale).toBe(true);
    put('status.json', noTick, HOUR);
    expect(pick(await lanes(), 'claude').stale).toBe(false);
  });

  it('degrades on malformed or symlinked status.json', async () => {
    put('status.json', '{not json');
    expect(pick(await lanes(), 'zai').known).toBe(false);
    rmSync(join(root, 'queue', 'status.json'));
    writeFileSync(join(root, 'real.json'), JSON.stringify(status));
    symlinkSync(join(root, 'real.json'), join(root, 'queue', 'status.json'));
    expect((await lanes()).some(l => l.lane === 'claude')).toBe(false);
  });

  it('computes zai rolling 5h and 7d windows from events plus reserved', async () => {
    put('zai.usage.json', {
      events: [
        [(NOW - 6 * HOUR) / 1000, 500],   // outside 5h, inside 7d
        [(NOW - 4 * HOUR) / 1000, 300],   // epoch seconds
        [NOW - 1 * HOUR, 200],            // epoch ms
        [new Date(NOW - 8 * 24 * HOUR).toISOString(), 9999], // outside 7d
        ['bad', 5], [NOW - HOUR, -3], 'junk',
      ],
      reserved: 100,
    });
    const all = await lanes();
    const five = pick(all, 'zai', '5h');
    expect(five).toMatchObject({ provider: 'zai', known: true, quota_unit: 'credits', used: 600, limit: 2000, remaining: 1400, stale: false, overage_costs_money: false });
    expect(five.reset_at).toBe(new Date(NOW - 4 * HOUR + 5 * HOUR).toISOString());
    expect(five.seconds_to_reset).toBe(3600);
    expect(five.burn_per_hour).toBe(100);
    expect(five.projected_used_at_reset).toBe(500);
    expect(five.projected_unused_at_reset).toBe(1500);
    expect(five.waste_risk).toBe('high');
    const seven = pick(all, 'zai', '7d');
    expect(seven).toMatchObject({ used: 1100, limit: 10000, remaining: 8900 });
    expect(seven.reset_at).toBe(new Date(NOW - 6 * HOUR + 7 * 24 * HOUR).toISOString());
  });

  it('flags a saturated zai window as low waste and an idle one with no reset', async () => {
    put('zai.usage.json', { events: [[NOW - HOUR, 2500]], reserved: 0 });
    expect(pick(await lanes(), 'zai', '5h')).toMatchObject({ used: 2500, remaining: 0, waste_risk: 'low' });
    put('zai.usage.json', { events: [], reserved: 0 });
    expect(pick(await lanes(), 'zai', '5h')).toMatchObject({ known: true, used: 0, reset_at: null, seconds_to_reset: null });
  });

  it('marks zai stale when the file and its newest event are older than 24h', async () => {
    put('zai.usage.json', { events: [[NOW - 30 * HOUR, 10]], reserved: 0 }, 26 * HOUR);
    const row = pick(await lanes(), 'zai', '7d');
    expect(row).toMatchObject({ stale: true, used: 10 });
    expect(pick(await lanes(), 'zai', '5h').used).toBe(0);
  });

  it('merges lane counts from status.json into zai and gemini rows', async () => {
    put('status.json', { ...status, lanes: { ...status.lanes, gemini: { running: 1, target: 2, ceiling: 3, held: true, queued: 4 } } });
    put('zai.usage.json', { events: [], reserved: 0 });
    const all = await lanes();
    expect(pick(all, 'zai', '5h')).toMatchObject({ running: 1, queued: 7, ceiling: 3 });
    expect(pick(all, 'gemini')).toMatchObject({ running: 1, queued: 4, held: true, known: false });
  });

  it('reads the gemini daily pacer and rolls an old-day counter over', async () => {
    put('gemini.pacer.json', { date: '2026-11-03', used: 250 });
    const g = pick(await lanes(), 'gemini');
    expect(g).toMatchObject({ provider: 'google', quota_unit: 'requests', window: 'daily', used: 250, limit: 1000, remaining: 750, known: true });
    expect(g.reset_at).toBe('2026-11-04T00:00:00.000Z');
    expect(g.seconds_to_reset).toBe(12 * 3600);
    expect(g.burn_per_hour).toBeCloseTo(250 / 12, 2);
    expect(g.projected_used_at_reset).toBeCloseTo(500, 1);
    expect(g.waste_risk).toBe('high');
    put('gemini.pacer.json', { date: '2026-11-02', count: 900 });
    expect(pick(await lanes(), 'gemini')).toMatchObject({ used: 0, remaining: 1000 });
  });

  it('marks a gemini pacer file older than 24h stale', async () => {
    put('gemini.pacer.json', { date: '2026-11-03', used: 1 }, 48 * HOUR);
    expect(pick(await lanes(), 'gemini').stale).toBe(true);
  });

  it('emits only numbers, booleans and fixed labels, never source text or secrets', async () => {
    put('status.json', {
      ...status,
      budget: { ...status.budget, claude: { ...status.budget.claude, source: '/Users/x/secret', api_key: 'sk-ant-LEAK', token: 'tok-LEAK' } },
      lanes: { ...status.lanes, 'bad lane/../x': { running: 1 }, [`k${'x'.repeat(90)}`]: {} },
    });
    put('zai.usage.json', { events: [], reserved: 0, api_key: 'zai-LEAK' });
    put('gemini.pacer.json', { used: 1, key: 'AIza-LEAK' });
    const text = JSON.stringify(await readFleetUsage({ runsDir: root, now: () => NOW }));
    expect(text).not.toMatch(/LEAK|secret|Users|bad lane/);
    for (const l of await lanes()) {
      expect(Object.keys(l).sort()).toEqual(['burn_per_hour', 'ceiling', 'held', 'known', 'lane', 'limit', 'overage_costs_money', 'projected_unused_at_reset',
        'projected_used_at_reset', 'provider', 'queued', 'quota_unit', 'remaining', 'reset_at', 'running', 'seconds_to_reset', 'source', 'stale',
        'target', 'used', 'waste_risk', 'window']);
    }
  });

  it('ignores negative and non-finite numbers', async () => {
    put('status.json', { last_tick: new Date(NOW).toISOString(), lanes: { claude: { running: -1, queued: 'x' } }, budget: { claude: { weekly_used_pct: -5 } } });
    expect(pick(await lanes(), 'claude')).toMatchObject({ running: null, queued: null, used: null, known: true });
  });
});
