import { describe, expect, it } from 'vitest';
import { lessonArm, lessonHoldoutFraction, lessonTrial, prKey, renderLessonEffect, DEFAULT_LESSON_HOLDOUT, MAX_LESSON_HOLDOUT } from '../src/core/improve/lesson-trial.js';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';

let n = 0;
function task(state: CloudTaskV1['state'], arm: 'served' | 'holdout', noteIds: string[] = ['n1'], pr: number | null = null): CloudTaskV1 {
  n += 1;
  return { id: `t${n}`, repo: 'ashlrai/phantom', state, lessons: { arm, noteIds },
    pr: pr === null ? null : { number: pr, url: `https://github.com/ashlrai/phantom/pull/${pr}`, state: 'merged', draft: false, title: 'x' } } as unknown as CloudTaskV1;
}
const many = (count: number, state: CloudTaskV1['state'], arm: 'served' | 'holdout', noteIds?: string[]) => Array.from({ length: count }, () => task(state, arm, noteIds));

describe('lessons trial', () => {
  it('assigns arms deterministically at about the holdout rate, and never holds out at 0', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `task-${i}`);
    const held = ids.filter((id) => lessonArm(id, 0.2) === 'holdout').length / ids.length;
    expect(held).toBeGreaterThan(0.17);
    expect(held).toBeLessThan(0.23);
    expect(ids.map((id) => lessonArm(id, 0.2))).toEqual(ids.map((id) => lessonArm(id, 0.2)));
    expect(ids.every((id) => lessonArm(id, 0) === 'served')).toBe(true);
  });

  it('reads the holdout from the environment within bounds', () => {
    expect(lessonHoldoutFraction({})).toBe(DEFAULT_LESSON_HOLDOUT);
    expect(lessonHoldoutFraction({ ASHLR_LESSON_HOLDOUT: '0' })).toBe(0);
    expect(lessonHoldoutFraction({ ASHLR_LESSON_HOLDOUT: '0.9' })).toBe(MAX_LESSON_HOLDOUT);
    expect(lessonHoldoutFraction({ ASHLR_LESSON_HOLDOUT: 'lots' })).toBe(DEFAULT_LESSON_HOLDOUT);
  });

  it('keeps the effect unknown until each arm has enough finished runs', () => {
    const r = lessonTrial([...many(5, 'merged', 'served'), ...many(2, 'closed', 'holdout')]);
    expect(r.overall).toMatchObject({ delta: null, ci95: null, verdict: 'unknown', served: { tasks: 5, landed: 5 }, holdout: { tasks: 2, landed: 0 } });
    expect(renderLessonEffect(r.overall)).toContain('effect unknown');
  });

  it('measures served against holdout, per note too, and calls a clear gain', () => {
    const tasks = [...many(18, 'merged', 'served', ['n1', 'n2']), ...many(2, 'closed', 'served', ['n1']),
      ...many(3, 'merged', 'holdout', ['n1']), ...many(7, 'expired', 'holdout', ['n1', 'n2'])];
    const r = lessonTrial(tasks);
    expect(r.overall.served).toEqual({ tasks: 20, landed: 18, rate: 0.9 });
    expect(r.overall.holdout).toEqual({ tasks: 10, landed: 3, rate: 0.3 });
    expect(r.overall.delta).toBeCloseTo(0.6);
    expect(r.overall.verdict).toBe('helps');
    expect(r.byNote.map((e) => [e.scope, e.served.tasks, e.holdout.tasks])).toEqual([['n1', 20, 10], ['n2', 18, 7]]);
    expect(renderLessonEffect(r.overall)).toMatch(/effect \+60 points \(95% CI \+\d+ to \+\d+\), helps/);
  });

  it('a reverted merge did not land, and launch failures and running tasks are not counted', () => {
    const reverted = task('merged', 'served', ['n1'], 42);
    const r = lessonTrial([reverted, task('failed', 'holdout'), task('running', 'served'), task('merged', 'served', [])], new Set([prKey('AshlrAI/Phantom', 42)]));
    expect(r.overall.served).toEqual({ tasks: 1, landed: 0, rate: 0 });
    expect(r.excluded).toEqual({ launchFailed: 1, unfinished: 1 });
  });
});
