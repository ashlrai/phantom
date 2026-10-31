/**
 * Job shape (src/core/decide/job-shape.ts): Jev may raise complexity, context
 * or latency, but risk is escalate-only — a model answer cannot make a job
 * safer than the length-and-keyword heuristic already measured.
 */

import { describe, expect, it } from 'vitest';

import { classifyJob, jobShapeHeuristic, type JobShape } from '../src/core/decide/job-shape.js';
import type { Decision } from '../src/core/decide/types.js';

function decision(value: JobShape, path: 'jev' | 'fallback'): Decision<JobShape> {
  return {
    kind: 'job-shape',
    value,
    path,
    confidence: 1,
    threshold: 0.75,
    cached: false,
    durationMs: 0,
    ...(path === 'fallback' ? { reason: 'no-key' as const } : {}),
  };
}

describe('jobShapeHeuristic', () => {
  it('reads risk and latency from the text and complexity from length', () => {
    expect(jobShapeHeuristic('Rotate the deploy secret in the auth path')).toMatchObject({ risk: 'high', complexity: 'low' });
    expect(jobShapeHeuristic('plan the migration')).toMatchObject({ complexity: 'high' });
    expect(jobShapeHeuristic('fix this now')).toMatchObject({ latency: 'interactive' });
    expect(jobShapeHeuristic('move the helper')).toMatchObject({ risk: 'low', complexity: 'low', latency: 'batch' });
    expect(jobShapeHeuristic('x'.repeat(9_000)).complexity).toBe('high');
    expect(jobShapeHeuristic('x'.repeat(900)).complexity).toBe('medium');
    expect(jobShapeHeuristic('x'.repeat(500)).contextTokens).toBe(500);
  });
});

describe('classifyJob', () => {
  it('uses the heuristic when Jev falls back, and will not accept a lower risk', async () => {
    const text = 'Rotate the deploy secret in the auth path';
    const fallback = await classifyJob(text, {
      ask: async () => decision(jobShapeHeuristic(''), 'fallback'),
    });
    expect(fallback).toMatchObject({ source: 'heuristic', risk: 'high' });
    const lowered = await classifyJob(text, {
      ask: async () => decision({ ...jobShapeHeuristic(text), risk: 'low', source: 'jev' }, 'jev'),
    });
    expect(lowered.risk).toBe('high');
    expect(lowered.source).toBe('jev');
    expect(lowered.contextTokens).toBeGreaterThanOrEqual(text.length);
  });

  it('lets Jev raise risk and context but never shrink measured context', async () => {
    const text = `update the docs ${'x'.repeat(40_000)}`;
    const heard: JobShape = { complexity: 'medium', risk: 'medium', contextTokens: 100_000, latency: 'interactive', source: 'jev' };
    const raised = await classifyJob(text, { ask: async () => decision(heard, 'jev') });
    expect(raised).toMatchObject({ source: 'jev', risk: 'medium', contextTokens: 100_000, latency: 'interactive' });
    const shrunk = await classifyJob(text, { ask: async () => decision({ ...heard, contextTokens: 2_000 }, 'jev') });
    expect(shrunk.contextTokens).toBe(40_000 + 'update the docs '.length);
  });

  it('returns the heuristic for blank text and when the ask throws', async () => {
    expect((await classifyJob('   ')).source).toBe('heuristic');
    const thrown = await classifyJob('refactor the parser', {
      ask: async () => { throw new Error('jev exploded'); },
    });
    expect(thrown.source).toBe('heuristic');
  });
});
