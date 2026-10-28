/**
 * Reliability: a conductor/worker killed mid-advance (SIGKILL, OOM, reboot)
 * leaves its milestone 'in-progress'. nextActionableMilestone treats that as a
 * gate, so without recovery the resident conductor skips the goal silently on
 * every later cycle ("nothing to advance") forever. The conductor must reuse
 * the existing proposal-less stale-lane recovery before selecting work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';

vi.mock('../src/core/daemon/activation-permit.js', () => ({
  liveConductorActivationAuthorized: () => true,
}));

let killSwitch = false;
vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => killSwitch,
  listEnrolled: () => ['/abs/repo'],
  assertMayMutate: () => undefined,
}));

const advanceGoalCycle = vi.fn(async () => ({ proposalsFiled: 0, goalDone: false, runs: [] }));
vi.mock('../src/core/goals/advance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/goals/advance.js')>()),
  advanceGoalCycle: (...args: unknown[]) => advanceGoalCycle(...(args as [])),
}));

const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-stale-lane-'));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  killSwitch = false;
  advanceGoalCycle.mockClear();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = originalUserProfile;
  rmSync(home, { recursive: true, force: true });
});

const HOURS = 60 * 60 * 1000;

async function seedCrashedLane(ageMs: number) {
  const store = await import('../src/core/goals/store.js');
  const started = new Date(Date.now() - ageMs).toISOString();
  const goal = store.createGoal('Crash-interrupted goal', { project: '/abs/repo', now: started });
  const withMilestones = store.addMilestone(goal.id, { title: 'First', detail: 'd' }, { now: started });
  store.addMilestone(goal.id, { title: 'Second', detail: 'd' }, { now: started });
  const first = withMilestones!.milestones[0]!.id;
  // The worker set the lane in-progress, then died before settling it.
  store.updateMilestoneStatus(goal.id, first, 'in-progress', { swarmId: 'dead-swarm', now: started });
  return { store, goalId: goal.id, milestoneId: first };
}

describe('goal conductor: crash-interrupted in-progress lanes', { timeout: 30_000 }, () => {
  it('recovers a stale proposal-less in-progress lane and advances the goal again', async () => {
    const { store, goalId, milestoneId } = await seedCrashedLane(7 * HOURS);
    const { runConductor } = await import('../src/core/goals/conductor.js');

    const summary = await runConductor({} as AshlrConfig, { once: true, dryRun: false });

    expect(summary.staleLanesRecovered).toBe(1);
    expect(store.loadGoal(goalId)!.milestones.find((m) => m.id === milestoneId)!.status).toBe('pending');
    expect(advanceGoalCycle).toHaveBeenCalledTimes(1);
    expect(summary.goalsAdvanced).toBe(1);
  });

  it('leaves a young in-progress lane alone (a live worker may still own it)', async () => {
    const { store, goalId, milestoneId } = await seedCrashedLane(5 * 60 * 1000);
    const { runConductor } = await import('../src/core/goals/conductor.js');

    const summary = await runConductor({} as AshlrConfig, { once: true, dryRun: false });

    expect(summary.staleLanesRecovered ?? 0).toBe(0);
    expect(store.loadGoal(goalId)!.milestones.find((m) => m.id === milestoneId)!.status).toBe('in-progress');
    expect(advanceGoalCycle).not.toHaveBeenCalled();
  });

  it('does not recover lanes in dry-run or while the kill switch is on', async () => {
    const { store, goalId, milestoneId } = await seedCrashedLane(7 * HOURS);
    const { runConductor } = await import('../src/core/goals/conductor.js');

    await runConductor({} as AshlrConfig, { once: true, dryRun: true });
    killSwitch = true;
    await runConductor({} as AshlrConfig, { once: true, dryRun: false });

    expect(store.loadGoal(goalId)!.milestones.find((m) => m.id === milestoneId)!.status).toBe('in-progress');
    expect(advanceGoalCycle).not.toHaveBeenCalled();
  });
});
