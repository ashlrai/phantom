import { describe, expect, it } from 'vitest';
import {
  assertQueueTier, closestQueueTier, isQueueTier, queueTierProblem, QUEUE_TIERS,
} from '../src/core/drive/queue-tier.js';

describe('queue tier vocabulary', () => {
  it('matches the four tiers dispatchd accepts', () => {
    expect([...QUEUE_TIERS]).toEqual(['frontier', 'work', 'mid', 'fast']);
  });

  it.each(['frontier', 'work', 'mid', 'fast'])('accepts %s', (tier) => {
    expect(isQueueTier(tier)).toBe(true);
    expect(queueTierProblem(tier)).toBeNull();
    expect(assertQueueTier(tier)).toBe(tier);
  });

  it.each(['standard', 'low', 'q8', 'Work', '', 'fast ', 'constructor'])('refuses %j', (value) => {
    expect(isQueueTier(value)).toBe(false);
    expect(queueTierProblem(value)).toContain('allowed: frontier, work, mid, fast');
    expect(() => assertQueueTier(value)).toThrow('invalid queue line: unknown tier');
  });

  it('maps standard to work and suggests edit-distance matches', () => {
    expect(closestQueueTier('standard')).toBe('work');
    expect(closestQueueTier('Work')).toBe('work');
    expect(closestQueueTier('mdi')).toBe('mid');
    expect(closestQueueTier('q8')).toBeUndefined();
    expect(queueTierProblem('q8')).not.toContain('did you mean');
  });

  it('echoes at most 40 characters of a rejected value', () => {
    const problem = queueTierProblem('x'.repeat(500)) ?? '';
    expect(problem.indexOf('x'.repeat(41))).toBe(-1);
    expect(problem).toContain(`unknown tier "${'x'.repeat(40)}"`);
  });
});
