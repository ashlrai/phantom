import { worldLaneRows } from '../src/web-ui/routes/verse/resources/world-lane-rows.js';
import { describe, expect, it } from 'vitest';
import { projectWorldModel, type WorldProjectInput } from '../src/core/world/project.js';
import { planFable } from '../src/core/routing/fable-orchestrator.js';
const now = Date.parse('2026-11-13T20:00:00Z');
const input: WorldProjectInput = { nowMs: now, sensors: null, roster: null, claims: null, busReadable: null,
  queue: null, ci: null, updatePhase: null, bottlenecks: null, bottlenecksObservedAt: null, stepsRemaining: null,
  stepsObservedAt: null, outcomes: null };
describe('Fable world usage bar contract', () => {
  it('exports the orchestrator sublane with percentages of the overall allowance', () => {
    const plan = planFable({ role: 'leader' }, { observedAtMs: now - 1000, resetAtMs: now + 3 * 3600_000,
      claudeWeeklyUsedPercent: 60, fableOverallWeeklyUsedPercent: 40, codingBurnPercentPerHour: 2, nextPlanPercent: 1 }, 50, false, now);
    const lane = projectWorldModel({ ...input, fablePlan: plan }).sensors.lanes.find(lane => lane.lane === 'claude:fable');
    expect(lane).toMatchObject({ model: 'claude-fable-5-2', role: 'planning-orchestration',
      claudeWeeklyUsedPercent: { value: 60 }, fableOverallWeeklyUsedPercent: { value: 40 },
      used: { value: 40, observedAt: new Date(now - 1000).toISOString() }, remaining: { value: 10 } });
    const row = worldLaneRows(projectWorldModel({ ...input, fablePlan: plan }), now).find(row => row.lane === 'claude:fable');
    expect(row?.label).toContain('planning and orchestration');
    expect(row?.usage).toContain('40%');
    expect(row?.usage).toContain('60%');
    expect(JSON.stringify(lane)).not.toMatch(/costUSD|total_cost_usd|spend/);
  });
  it('keeps unmeasured attribution unknown', () => {
    const plan = planFable({ role: 'leader' }, null, 50, false, now);
    const lane = projectWorldModel({ ...input, fablePlan: plan }).sensors.lanes.find(lane => lane.lane === 'claude:fable');
    expect(lane?.used).toMatchObject({ value: null, freshness: 'unknown' });
    expect(lane?.fableOverallWeeklyUsedPercent?.value).toBeNull();
  });
});
