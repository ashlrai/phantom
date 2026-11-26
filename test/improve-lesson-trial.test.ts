import { describe, expect, it } from 'vitest';
import { familyPromotionGate, lessonArm, lessonHoldoutFraction, lessonTrial, prKey, renderFamilyPromotion, renderLessonEffect, DEFAULT_LESSON_HOLDOUT, MAX_LESSON_HOLDOUT } from '../src/core/improve/lesson-trial.js';
import type { CloudTaskV1 } from '../src/core/cloud/types.js';

let n = 0;
function task(state: CloudTaskV1['state'], arm: 'served' | 'holdout', noteIds: string[] = ['n1'], pr: number | null = null): CloudTaskV1 {
  n += 1;
  return { id: `t${n}`, repo: 'ashlrai/phantom', state, lessons: { arm, noteIds },
    pr: pr === null ? null : { number: pr, url: `https://github.com/ashlrai/phantom/pull/${pr}`, state: 'merged', draft: false, title: 'x' } } as unknown as CloudTaskV1;
}
const many = (count: number, state: CloudTaskV1['state'], arm: 'served' | 'holdout', noteIds?: string[]) => Array.from({ length: count }, () => task(state, arm, noteIds));

const comparison = (family: string, candidate: boolean[], incumbent: boolean[]) => [
  ...candidate.map((passed) => ({ family, arm: 'candidate' as const, passed })),
  ...incumbent.map((passed) => ({ family, arm: 'incumbent' as const, passed })),
];

describe('family promotion gate', () => {
  it('retains the incumbent on any regression, even in an extra family when the aggregate wins', () => {
    const gate = familyPromotionGate([
      ...comparison('repair', [true, true, true], [false, false, false]),
      ...comparison('test-writing', [true, true, true], [false, false, false]),
      ...comparison('refactor', [true, true, true], [true, true, true]),
      ...comparison('documentation', [true, true, false], [true, true, true]),
    ]);
    expect(gate.aggregate.delta).toBeGreaterThan(0);
    expect(gate).toMatchObject({ promote: false, retained: 'incumbent', refusals: [{ family: 'documentation', reason: 'regressed' }] });
    expect(gate.families[3]).toMatchObject({
      family: 'documentation', verdict: 'regresses',
      candidate: { tasks: 3, landed: 2 }, incumbent: { tasks: 3, landed: 3 },
    });
    expect(renderFamilyPromotion(gate)).toContain('documentation: candidate 2/3 landed (67%), incumbent 3/3 landed (100%); regresses (-33 points)');
  });

  it('withholds deltas for undersampled or absent families even when the aggregate is measured', () => {
    const gate = familyPromotionGate([
      ...comparison('repair', [true, true, true], [true, true, true]),
      ...comparison('test-writing', [true, true, true], [false, false]),
    ]);
    expect(gate.aggregate.delta).not.toBeNull();
    expect(gate).toMatchObject({
      promote: false, retained: 'incumbent',
      families: [
        { family: 'repair', delta: 0, verdict: 'holds' },
        { family: 'test-writing', delta: null, verdict: 'unknown' },
        { family: 'refactor', delta: null, verdict: 'unknown', incumbent: { rate: null }, candidate: { rate: null } },
      ],
      refusals: [
        { family: 'test-writing', reason: 'insufficient-samples' },
        { family: 'refactor', reason: 'insufficient-samples' },
      ],
    });
  });

  it('passes the family gate only when every configured cohort improves or holds', () => {
    const gate = familyPromotionGate([
      ...comparison('repair', [true], [false]),
      ...comparison('refactor', [false], [false]),
    ], { families: ['repair', 'refactor'], minPerArm: 1 });
    expect(gate).toMatchObject({
      promote: true, retained: 'candidate', refusals: [],
      families: [{ verdict: 'improves', delta: 1 }, { verdict: 'holds', delta: 0 }],
    });
  });

  it('never promotes an empty evaluation and rejects invalid sample floors', () => {
    expect(familyPromotionGate([], { families: [] })).toMatchObject({
      families: [], aggregate: { delta: null }, promote: false, retained: 'incumbent',
    });
    expect(() => familyPromotionGate([], { minPerArm: Number.NaN })).toThrow(RangeError);
  });
});

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

  it('records classified and unclassified lesson evidence using the same landing fold', () => {
    const reverted = task('merged', 'served', ['n1'], 42);
    reverted.lessons!.family = 'repair';
    const report = lessonTrial([reverted, task('merged', 'holdout'), task('running', 'served')], new Set([prKey('AshlrAI/Phantom', 42)]));
    expect(report.byFamily).toMatchObject({
      promote: false, retained: 'incumbent',
      families: [
        { family: 'repair', candidate: { tasks: 1, landed: 0 }, verdict: 'unknown' },
        { family: 'test-writing', verdict: 'unknown' },
        { family: 'refactor', verdict: 'unknown' },
        { family: 'unclassified', candidate: { tasks: 0 }, incumbent: { tasks: 1, landed: 1 }, verdict: 'unknown' },
      ],
    });
  });

  it('a cloud task that records its own revert did not land', () => {
    const t = { ...task('merged', 'served', ['n1'], 7), outcome: { observedAt: 'x', headSha: null, mergeSha: null, ci: null, failedChecks: [], reviewDecision: null, changesRequested: 0, revertedBy: 'd'.repeat(40) } } as CloudTaskV1;
    expect(lessonTrial([t, task('merged', 'served')]).overall.served).toEqual({ tasks: 2, landed: 1, rate: 0.5 });
  });

  it('revertedPrKeys unions ledger reverts and cloud task reverts', async () => {
    const { revertedPrKeys } = await import('../src/core/improve/reverted.js');
    const base = task('merged', 'served', ['n1'], 9);
    const outcome = { observedAt: 'x', headSha: null, mergeSha: null, ci: null, failedChecks: [], reviewDecision: null, changesRequested: 0 };
    expect(revertedPrKeys([{ ...base, outcome } as CloudTaskV1], []).size).toBe(0);
    const reverted = { ...base, outcome: { ...outcome, revertedBy: 'd'.repeat(40) } } as CloudTaskV1;
    expect([...revertedPrKeys([reverted], [])]).toEqual(['ashlrai/phantom#9']);
  });
});
