/** Exact saved goal milestones are the identity for new Leader tasks. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addMilestone, createGoal, updateMilestoneStatus } from '../src/core/goals/store.js';
import { enqueueTask, readTaskQueue } from '../src/core/fleet/task-source.js';
import type { FleetTaskInput } from '../src/core/fleet/fleet-types.js';
import { buildLeaderGoalEvidence } from '../src/core/vision/leader-goal-evidence.js';
import { parseActionParams } from '../src/core/vision/leader-memo.js';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
let dir: string;
let file: string;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'leader-milestone-'));
  vi.stubEnv('HOME', dir);
  file = join(dir, '.ashlr', 'fleet', 'tasks.json');
  repo = join(dir, 'binshield');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/ashlrai/binshield.git\n');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function task(goalId: string, milestoneId: string, title: string): FleetTaskInput {
  return { repo: 'ashlrai/binshield', source: 'leader', requestedBy: 'leader',
    title, detail: 'One verified slice', difficulty: 'low', value: 4, goalId, milestoneId };
}

function goalWithMilestones() {
  const created = createGoal(`Repair the parser in ${dir}`, { project: repo, now: new Date(NOW).toISOString() });
  const first = addMilestone(created.id, { title: 'Repair parser', detail: 'Fix the parser' }, { now: new Date(NOW + 1000).toISOString() });
  const second = addMilestone(created.id, { title: 'Add regression tests', detail: 'Test parser failures' }, { now: new Date(NOW + 2000).toISOString() });
  if (!first || !second) throw new Error('fixture goal could not be planned');
  return { goal: second, firstId: second.milestones[0]!.id, secondId: second.milestones[1]!.id };
}

const options = () => ({ file, nowMs: NOW + 3000, sizeBudget: { files: 4, lines: 150 } });

describe('exact milestone queue admission', () => {
  it('exposes exact pending ids in Leader evidence and accepts an optional action milestone', () => {
    const { goal, firstId, secondId } = goalWithMilestones();
    const evidence = buildLeaderGoalEvidence({ goals: [goal], complete: true, unreadable: 0 });
    expect(evidence.items[0]?.pendingMilestones).toEqual([
      { id: firstId, title: 'Repair parser' },
      { id: secondId, title: 'Add regression tests' },
    ]);
    const fields = { repo: 'ashlrai/binshield', title: 'Fix parser', difficulty: 'low', value: 3, goalId: goal.id };
    const parsed = parseActionParams('work.dispatch', { task: { ...fields, milestoneId: firstId } });
    expect(parsed.ok && parsed.params.task).toMatchObject({ goalId: goal.id, milestoneId: firstId, source: 'leader' });
    expect(parseActionParams('work.dispatch', { task: { ...fields, milestoneId: 'bad id' } }).ok).toBe(false);
    expect(parseActionParams('work.dispatch', { task: { repo: fields.repo, title: fields.title,
      difficulty: fields.difficulty, value: fields.value, milestoneId: firstId } }).ok).toBe(false);
  });

  it('dedupes reworded work for one pending milestone but admits a distinct pending milestone', () => {
    const { goal, firstId, secondId } = goalWithMilestones();
    const first = enqueueTask(task(goal.id, firstId, 'Fix missing bin'), options());
    const reworded = enqueueTask(task(goal.id, firstId, 'Restore CLI target and add a test'), options());
    const distinct = enqueueTask(task(goal.id, secondId, 'Fix missing bin'), options());
    expect(first.ok && reworded.ok && distinct.ok).toBe(true);
    if (!first.ok || !reworded.ok || !distinct.ok) return;
    expect(reworded).toMatchObject({ deduped: true, task: { id: first.task.id, milestoneId: firstId } });
    expect(distinct).toMatchObject({ deduped: false, task: { milestoneId: secondId } });
    expect(distinct.task.id).not.toBe(first.task.id);
    const read = readTaskQueue(file);
    expect(read.ok && read.tasks).toHaveLength(2);
  });

  it('rejects unknown, stale, mismatched-repo and unpaired milestone identity without a queue write', () => {
    const { goal, firstId, secondId } = goalWithMilestones();
    expect(enqueueTask(task(goal.id, 'not-a-saved-milestone', 'Unknown'), options())).toMatchObject({ ok: false, writeAttempted: false });
    expect(enqueueTask({ ...task(goal.id, firstId, 'Wrong repo'), repo: 'ashlrai/phantom' }, options())).toMatchObject({ ok: false, writeAttempted: false });
    expect(enqueueTask({ ...task(goal.id, firstId, 'No goal'), goalId: null }, options())).toMatchObject({ ok: false, writeAttempted: false });
    expect(updateMilestoneStatus(goal.id, secondId, 'done', { now: new Date(NOW + 4000).toISOString() })).not.toBeNull();
    expect(enqueueTask(task(goal.id, secondId, 'Finished slice'), options())).toMatchObject({ ok: false, writeAttempted: false });
    expect(readTaskQueue(file)).toEqual({ ok: true, tasks: [] });
  });

  it('keeps legacy goal tasks readable and rejects corrupt exact-milestone records', () => {
    const legacy = enqueueTask({ repo: 'ashlrai/binshield', source: 'leader', requestedBy: 'leader',
      title: 'Legacy task', detail: '', difficulty: 'low', value: 3, goalId: 'legacy-goal', dedupeKey: 'leader:legacy' }, options());
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    const loaded = readTaskQueue(file);
    expect(loaded.ok && loaded.tasks[0]).toMatchObject({ id: legacy.task.id, goalId: 'legacy-goal' });
    if (loaded.ok) expect(loaded.tasks[0]).not.toHaveProperty('milestoneId');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { tasks: Record<string, unknown>[] };
    raw.tasks[0]!.milestoneId = 'not valid whitespace';
    writeFileSync(file, JSON.stringify(raw));
    expect(readTaskQueue(file)).toMatchObject({ ok: false });
  });
});
