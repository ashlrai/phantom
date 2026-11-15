import { describe, expect, it, vi } from 'vitest';
import { planFleetShed } from '../src/core/fleet/shed-plan.js';
import { cmdFleetShedPlan } from '../src/cli/fleet-shed-plan.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const fixture = { mem_free_pct: 21, swap_gb: 2, lanes: { 'codex-local': { running: 9 }, 'codex-personal': { running: 0 } }, rollup_24h: { by_lane: { 'codex-local': { merged: 4 }, 'codex-personal': { merged: 478 } } } };

describe('fleet shed plan', () => {
  it('sheds local first and keeps the idle cloud lane admitting', () => {
    const plan = planFleetShed(fixture);
    expect(plan.pressure).toBe('high');
    expect(plan.lanes).toMatchObject([{ lane: 'codex-local', recommendation: 'shed', merged: 4, ramGb: null, mergedPerGb: null }, { lane: 'codex-personal', recommendation: 'keep', merged: 478, running: 0 }]);
    expect(plan.nextAction).toContain('Reduce codex-local admission first');
  });
  it('orders measured efficiency within a kind and keeps missing data unknown', () => {
    const plan = planFleetShed({ mem_free_pct: 30, lanes: { 'a-local': { running: 1, ram_gb: 2 }, 'b-local': { running: 1, ram_gb: 4 }, 'c-local': { running: 1 } }, rollup_24h: { by_lane: { 'a-local': { merged: 4 }, 'b-local': { merged: 4 } } } });
    expect(plan.lanes.map(lane => lane.lane)).toEqual(['b-local', 'a-local', 'c-local']);
    expect(plan.lanes[2]?.mergedPerGb).toBeNull();
    expect(planFleetShed({ lanes: { 'codex-local': { running: 1 } } }).lanes[0]?.recommendation).toBe('unknown');
    expect(planFleetShed({ mem_free_pct: 31, lanes: { 'codex-local': { running: 1 } } }).lanes[0]?.recommendation).toBe('keep');
  });
  it('exposes JSON and a plain next action through the registered CLI', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect((await FLEET_SUBCOMMAND_LOADERS['shed-plan']!()).cmdFleetShedPlan).toBe(cmdFleetShedPlan);
      expect(await cmdFleetShedPlan(['--json'], async () => JSON.stringify(fixture))).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).lanes[0].recommendation).toBe('shed');
      expect(await cmdFleetShedPlan([], async () => JSON.stringify(fixture))).toBe(0);
      expect(String(log.mock.calls[1]?.[0])).toContain('Reduce codex-local admission first');
      expect(await cmdFleetShedPlan(['--json'], async () => 'bad secret')).toBe(2);
      expect(String(log.mock.calls[2]?.[0])).not.toContain('bad secret');
    } finally { log.mockRestore(); }
  });
});
