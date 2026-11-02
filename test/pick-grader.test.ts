/** RQ-PSEL-3-GRADER — pick grading, weight updates and the daily accuracy line. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatPickAccuracyLine, gradePicks, pickGraderPaths, predict, realizedScore,
  runPickGrader, updateWeights, type PickRecord, type PickSignals,
} from '../src/core/fleet/pick-grader.js';

const H = 3_600_000;
const win: PickSignals = { merged: true, used: true, stars: 100, installs: 100 };
const lose: PickSignals = { merged: false, used: false, stars: 0, installs: 0 };
const pick = (id: string, pickedAt: number, f = { a: 1 }): PickRecord => ({ id, pickedAt, features: f });

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'pick-grader-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('realizedScore / predict', () => {
  it('spans 0..1 and ignores junk numbers', () => {
    expect(realizedScore(lose)).toBe(0);
    expect(realizedScore(win)).toBeCloseTo(1);
    expect(realizedScore({ ...lose, stars: NaN, installs: -5 })).toBe(0);
  });
  it('clamps predictions and treats unknown features as weight 0', () => {
    expect(predict({ a: 3 }, { a: 1, b: 1 })).toBe(1);
    expect(predict({}, { a: 1 })).toBe(0);
  });
});

describe('gradePicks', () => {
  it('grades only elapsed, ungraded windows with readable signals', () => {
    const now = 10 * 24 * H;
    const picks = [pick('old', 0), pick('mid', now - 30 * H), pick('new', now - H)];
    const grades = gradePicks(picks, [], { a: 0.9 }, (p) => (p.id === 'old' ? undefined : win), now);
    expect(grades.map((g) => `${g.pickId}:${g.window}`)).toEqual(['mid:24h']);
    expect(grades[0]!.hit).toBe(true);
    const again = gradePicks(picks, grades, { a: 0.9 }, () => win, now);
    expect(again.map((g) => `${g.pickId}:${g.window}`).sort()).toEqual(['old:24h', 'old:7d']);
  });
});

describe('updateWeights', () => {
  it('raises weights on under-prediction, lowers on over-prediction, stays in [0,1]', () => {
    const now = 8 * 24 * H;
    const up = gradePicks([pick('p', 0)], [], { a: 0.1 }, () => win, now);
    expect(updateWeights({ a: 0.1 }, up).a!).toBeGreaterThan(0.1);
    const down = gradePicks([pick('p', 0)], [], { a: 0.9 }, () => lose, now);
    const w = updateWeights({ a: 0.9 }, down).a!;
    expect(w).toBeLessThan(0.9);
    expect(w).toBeGreaterThanOrEqual(0);
  });
});

describe('formatPickAccuracyLine', () => {
  it('reports per-window hits and mae', () => {
    expect(formatPickAccuracyLine([])).toBe('picks: no graded picks yet');
    const now = 8 * 24 * H;
    const g = gradePicks([pick('p', 0)], [], { a: 1 }, () => win, now);
    expect(formatPickAccuracyLine(g)).toBe('picks 24h 1/1 100% · 7d 1/1 100% · mae 0.00');
  });
});

describe('runPickGrader', () => {
  it('persists grades and weights, never double-grades, and returns the line', () => {
    const now = 8 * 24 * H;
    const run = () => runPickGrader({
      home, now, picks: [pick('p', 0)], readSignals: () => win, defaultWeights: { a: 0.2 },
    });
    const first = run();
    expect(first.newGrades).toHaveLength(2);
    const paths = pickGraderPaths(home);
    expect(readFileSync(paths.grades, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(readFileSync(paths.weights, 'utf8')).a).toBeGreaterThan(0.2);
    const second = run();
    expect(second.newGrades).toHaveLength(0);
    expect(second.weights.a).toBe(first.weights.a);
    expect(second.line).toContain('24h 0/1');
  });
});
