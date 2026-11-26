import { describe, expect, it, vi } from 'vitest';
import { planFleetShed } from '../src/core/fleet/shed-plan.js';
import { cmdFleetShedPlan } from '../src/cli/fleet-shed-plan.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-26T12:00:00Z');
const lastTick = new Date(now).toISOString();
const fixture = { last_tick: lastTick, mem_free_pct: 21, swap_gb: 2, lanes: { 'codex-local': { running: 9 }, 'codex-personal': { running: 0 } }, rollup_24h: { by_lane: { 'codex-local': { merged: 4 }, 'codex-personal': { merged: 478 } } } };

describe('fleet shed plan', () => {
  it('sheds local first and keeps the idle cloud lane admitting', () => {
    const plan = planFleetShed(fixture, now);
    expect(plan.pressure).toBe('high');
    expect(plan.lanes).toMatchObject([{ lane: 'codex-local', recommendation: 'shed', merged: 4, ramGb: null, mergedPerGb: null }, { lane: 'codex-personal', recommendation: 'keep', merged: 478, running: 0 }]);
    expect(plan.nextAction).toContain('Reduce codex-local admission first');
  });
  it('orders measured efficiency within a kind and keeps missing data unknown', () => {
    const plan = planFleetShed({ last_tick: lastTick, mem_free_pct: 30, lanes: { 'a-local': { running: 1, ram_gb: 2 }, 'b-local': { running: 1, ram_gb: 4 }, 'c-local': { running: 1 } }, rollup_24h: { by_lane: { 'a-local': { merged: 4 }, 'b-local': { merged: 4 } } } }, now);
    expect(plan.lanes.map(lane => lane.lane)).toEqual(['b-local', 'a-local', 'c-local']);
    expect(plan.lanes[2]?.mergedPerGb).toBeNull();
    expect(planFleetShed({ last_tick: lastTick, lanes: { 'codex-local': { running: 1 } } }, now).lanes[0]?.recommendation).toBe('unknown');
    expect(planFleetShed({ ...fixture, mem_free_pct: 31 }, now).lanes[0]?.recommendation).toBe('keep');
  });
  it.each([
    undefined,
    'invalid',
    new Date(now + 1).toISOString(),
    new Date(now - 60_001).toISOString(),
  ])('withholds memory advice when the dispatcher tick is %s', last_tick => {
    const plan = planFleetShed({ ...fixture, last_tick }, now);
    expect(plan).toMatchObject({ pressure: 'unknown', memFreePct: null, swapGb: null });
    expect(plan.lanes).toHaveLength(2);
    for (const lane of plan.lanes) {
      expect(lane).toMatchObject({ recommendation: 'unknown', running: null, merged: null, ramGb: null, mergedPerGb: null });
    }
    expect(plan.gaps).toContain('Dispatcher status needs a readable last tick from the past 60 seconds.');
    expect(plan.nextAction).toBe('Check the memory reading before changing admission.');
  });
  it('accepts the last tick at the freshness boundary', () => {
    expect(planFleetShed(fixture, now + 60_000).lanes[0]?.recommendation).toBe('shed');
  });
  it('exposes JSON and a plain next action through the registered CLI', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect((await FLEET_SUBCOMMAND_LOADERS['shed-plan']!()).cmdFleetShedPlan).toBe(cmdFleetShedPlan);
      const current = { ...fixture, last_tick: new Date().toISOString() };
      expect(await cmdFleetShedPlan(['--json'], async () => JSON.stringify(current))).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).lanes[0].recommendation).toBe('shed');
      expect(await cmdFleetShedPlan([], async () => JSON.stringify(current))).toBe(0);
      expect(String(log.mock.calls[1]?.[0])).toContain('Reduce codex-local admission first');
      expect(await cmdFleetShedPlan(['--json'], async () => 'bad secret')).toBe(2);
      expect(String(log.mock.calls[2]?.[0])).not.toContain('bad secret');
    } finally { log.mockRestore(); }
  });
});
