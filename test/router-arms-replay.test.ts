/**
 * Hermetic replay of the task-aware seat router over fixture history
 * (fixtures/router-arms), following M15's deterministic test style.
 *
 * The flag is on inside the snapshots, so every recorded lane is the armed
 * router's own pick: a steered arm, a paced-out arm, a held class and the
 * flag-off baseline. Unknown engines can never be selected.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { routeSeat } from '../src/core/routing/router.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import { formatReplaySummary, replayRouter, type ReplayJob, type ReplayStatus } from './helpers/router-replay.js';

function fixture() {
  const jobs: ReplayJob[] = readFileSync(new URL('./fixtures/router-arms/jobs.jsonl', import.meta.url), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line) as ReplayJob);
  const status: ReplayStatus = JSON.parse(readFileSync(new URL('./fixtures/router-arms/status.json', import.meta.url), 'utf8'));
  return { jobs, status };
}

// Throw on accidental writes to any nested replay input, including router inputs.
function freeze(value: object): void {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
}

describe('task-aware arm replay', () => {
  it('replays every recorded lane through the armed router', () => {
    const { jobs, status } = fixture();
    freeze(jobs);
    freeze(status);
    const report = replayRouter(jobs, status);
    console.log(formatReplaySummary(report));
    expect(report.matches).toBe(7);
    expect(report.mismatches).toEqual([]);
    expect(report.decisions.map(d => [d.id, d.replayLane])).toEqual([
      ['armed-steer', 'claude'], ['paced-out', 'local:fixture'],
      ['flag-off', 'local:fixture'], ['review-baseline', 'local:fixture'],
      ['bogus-arm', 'local:fixture'], ['no-arm-seat', null],
      ['interactive', 'local:fixture'],
    ]);
    expect(report.actual).toEqual({ jobs: 5, merged: 3, tokens: 96000, mergedPrPerToken: 3 / 96000 });
    expect(report.matched).toEqual(report.actual);
    expect(report.byActualLane).toEqual([
      { lane: 'claude', jobs: 1, merged: 1, tokens: 40000, mergedPrPerToken: 1 / 40000 },
      { lane: 'local:fixture', jobs: 4, merged: 2, tokens: 56000, mergedPrPerToken: 2 / 56000 },
      { lane: null, jobs: 0, merged: 0, tokens: 0, mergedPrPerToken: null },
    ]);
    expect(replayRouter(jobs, status)).toEqual(report);
  });

  it('the steered pick really is the arm layer: the baseline picks a different lane', () => {
    const { jobs, status } = fixture();
    const armed = status.snapshots.armed!;
    const decision = routeSeat(jobs[0]!.request, armed.capacities, armed.policy, armed.options);
    expect(decision.seatId).toBe('claude');
    expect(decision.taskArm).toMatchObject({ engine: 'claude', model: 'claude-opus-4-6', effort: 'high' });
    const baselinePolicy: BudgetPolicy = { mode: armed.policy.mode, seats: armed.policy.seats, updatedAt: armed.policy.updatedAt };
    const baseline = routeSeat(jobs[0]!.request, armed.capacities, baselinePolicy, armed.options);
    expect(baseline.seatId).toBe('local:fixture');
    expect(baseline.taskArm).toBeUndefined();
  });

  it('flag off is byte-identical to the baseline decision on the same inputs', () => {
    const { jobs, status } = fixture();
    const armed = status.snapshots.armed!;
    const disabled: BudgetPolicy = {
      ...armed.policy,
      taskArms: { enabled: false, classes: { ...armed.policy.taskArms!.classes } },
    };
    const baselinePolicy: BudgetPolicy = { mode: armed.policy.mode, seats: armed.policy.seats, updatedAt: armed.policy.updatedAt };
    expect(routeSeat(jobs[0]!.request, armed.capacities, disabled, armed.options))
      .toEqual(routeSeat(jobs[0]!.request, armed.capacities, baselinePolicy, armed.options));
  });

  it('an arm ahead of its pacing ceiling changes the replayed lane', () => {
    const { jobs, status } = fixture();
    const paced = status.snapshots.paced!;
    const decision = routeSeat(jobs[1]!.request, paced.capacities, paced.policy, paced.options);
    expect(decision.seatId).toBe('local:fixture');
    const heldBack = decision.exclusions.find((e) => e.seatId === 'claude')!;
    expect(heldBack.details?.[0]?.kind).toBe('task-arm');
    expect(heldBack.nextEligibleAt).not.toBeNull();
  });

  it('a class armed only for a seatless engine holds instead of inventing one', () => {
    const { jobs, status } = fixture();
    const held = status.snapshots.held!;
    const decision = routeSeat(jobs[5]!.request, held.capacities, held.policy, held.options);
    expect(decision.seatId).toBeNull();
    expect(decision.candidates).toEqual([]);
    expect(decision.exclusions.every((e) => e.details?.some((d) => d.kind === 'task-arm'))).toBe(true);
  });
});
