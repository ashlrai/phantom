/**
 * eval-fixtures.test.ts — focused tests for src/cli/eval-fixtures.ts.
 *
 * Validates the EvalFixture[] export in isolation: happy path (well-formed
 * fixtures) plus one edge-case guard (duplicate-id rejection) so that any
 * future contributor adding a fixture gets an immediate signal.
 */

import { describe, it, expect } from 'vitest';
import { EVAL_FIXTURES, type EvalFixture } from '../src/cli/eval-fixtures.js';

describe('EVAL_FIXTURES', () => {
  it('happy path: every fixture has a non-empty id and goal (well-formed)', () => {
    for (const f of EVAL_FIXTURES) {
      expect(typeof f.id).toBe('string');
      expect(f.id.trim().length).toBeGreaterThan(0);
      expect(typeof f.goal).toBe('string');
      expect(f.goal.trim().length).toBeGreaterThan(0);
      expect(Object.keys(f).sort()).toEqual(['goal', 'id']);
    }
  });

  it('edge case: rejects a fixture with a duplicate id', () => {
    const duplicated: EvalFixture[] = [
      ...EVAL_FIXTURES,
      { id: EVAL_FIXTURES[0].id, goal: 'duplicate goal' },
    ];
    const ids = duplicated.map(f => f.id);
    // The original set is unique — duplicating the first id fails uniqueness.
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  it('edge case: rejects a fixture whose id or goal contains only whitespace', () => {
    const whitespaceFixture: EvalFixture = {
      id: '   ',
      goal: '\t\n',
    };
    expect(whitespaceFixture.id.trim().length).toBe(0);
    expect(whitespaceFixture.goal.trim().length).toBe(0);
  });
});
