import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { GOAL_OBJECTIVE_MAX_CHARS, goalAddErrorText, goalAddNotice, goalAddParse } from './goal-add-model.js';

describe('goalAddParse', () => {
  it('trims and accepts a normal objective', () => {
    expect(goalAddParse('  Ship the desktop release  ')).toEqual({ ok: true, objective: 'Ship the desktop release' });
  });

  it.each(['', '   ', '\t \n'])('refuses blank input %j', (input) => {
    expect(goalAddParse(input)).toEqual({ ok: false, reason: 'Type an objective first.' });
  });

  it('refuses an over-limit objective but accepts the boundary', () => {
    expect(goalAddParse('x'.repeat(GOAL_OBJECTIVE_MAX_CHARS + 1)).ok).toBe(false);
    expect(goalAddParse('x'.repeat(GOAL_OBJECTIVE_MAX_CHARS))).toEqual({ ok: true, objective: 'x'.repeat(GOAL_OBJECTIVE_MAX_CHARS) });
  });

  it.each(['line\nbreak', 'tab\there', 'bell\u0007', 'del\u007F', 'c1\u009F'])('refuses control characters in %j', (input) => {
    expect(goalAddParse(input).ok).toBe(false);
  });
});

describe('goalAddNotice', () => {
  it('maps created and exists to their sentences', () => {
    const goal = { id: 'g-1', objective: 'x', status: 'planning' };
    expect(goalAddNotice({ schema: 'verse.goal-create.v1', status: 'created', goal })).toBe('Added');
    expect(goalAddNotice({ schema: 'verse.goal-create.v1', status: 'exists', goal })).toBe('That goal already exists');
  });

  it('falls back on any other reply', () => {
    for (const body of [null, undefined, 42, 'created', [], {}, { status: 'failed' }, { status: 7 }]) {
      expect(goalAddNotice(body)).toBe('Could not add the goal.');
    }
  });
});

describe('goalAddErrorText', () => {
  it('prefers the server refusal sentence over the wrapper', () => {
    const err = new ApiError('POST /api/verse/goals failed (HTTP 400): an objective is required.', 400, '/api/verse/goals', 'an objective is required.');
    expect(goalAddErrorText(err)).toBe('an objective is required.');
  });

  it('falls back to the error message, then the fixed sentence', () => {
    expect(goalAddErrorText(new Error('network down'))).toBe('network down');
    expect(goalAddErrorText(new ApiError('POST /api/verse/goals failed (HTTP 500).', 500, '/api/verse/goals'))).toBe('POST /api/verse/goals failed (HTTP 500).');
    expect(goalAddErrorText(new Error('   '))).toBe('Could not add the goal.');
    expect(goalAddErrorText('nope')).toBe('Could not add the goal.');
  });
});
