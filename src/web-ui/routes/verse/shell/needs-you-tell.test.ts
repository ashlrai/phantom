import { describe, expect, it } from 'vitest';
import { tellLeadersPrefill } from './needs-you-tell.js';

describe('tellLeadersPrefill', () => {
  it('describes the Claude lane without including the next step', () => {
    expect(tellLeadersPrefill({
      title: 'The Claude lane is down',
      detail: 'Claude lane: down token rejected',
      nextStep: 'Run the fix script at /private/path',
    })).toBe('Re "The Claude lane is down": Claude lane: down token rejected. ');
  });

  it('trims and normalizes whitespace and avoids doubling a final period', () => {
    expect(tellLeadersPrefill({ title: '  Lane held  ', detail: '  Credit\n  exhausted.  ', nextStep: '' }))
      .toBe('Re "Lane held": Credit exhausted. ');
  });

  it('caps the entire prefill at 400 characters with an ellipsis', () => {
    const result = tellLeadersPrefill({ title: 'Incident', detail: 'x'.repeat(500), nextStep: '' });
    expect(result).toHaveLength(400);
    expect(result).toBe(`Re "Incident": ${'x'.repeat(384)}…`);
  });
});
