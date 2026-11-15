import { describe, expect, it } from 'vitest';
import { goalSteerText, steeredLabel } from './goal-steer-model.js';

const goal = { id: 'g1', objective: 'Grow the fleet' };

describe('goalSteerText', () => {
  it('returns null for empty or whitespace text', () => {
    expect(goalSteerText(goal, '')).toBeNull();
    expect(goalSteerText(goal, ' \n\t ')).toBeNull();
  });
  it('tags the goal id and objective', () => {
    expect(goalSteerText(goal, 'push harder')).toBe('[goal:g1] Grow the fleet: push harder');
  });
  it('collapses newlines into one line', () => {
    expect(goalSteerText({ id: 'g1', objective: 'a\nb' }, 'one\n\ntwo\r\nthree')).toBe('[goal:g1] a b: one two three');
  });
  it('caps the objective at 120 and the text at 600 characters', () => {
    const out = goalSteerText({ id: 'g1', objective: 'o'.repeat(200) }, 't'.repeat(900))!;
    expect(out).toBe(`[goal:g1] ${'o'.repeat(120)}: ${'t'.repeat(600)}`);
  });
});

describe('steeredLabel', () => {
  it('formats relative time', () => {
    expect(steeredLabel(1000, 1000)).toBe('Steered just now');
    expect(steeredLabel(0, 5 * 60_000)).toBe('Steered 5m ago');
    expect(steeredLabel(0, 3 * 3_600_000)).toBe('Steered 3h ago');
    expect(steeredLabel(0, 2 * 86_400_000)).toBe('Steered 2d ago');
  });
});
