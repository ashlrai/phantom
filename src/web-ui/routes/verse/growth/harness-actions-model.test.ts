import { describe, expect, it } from 'vitest';
import type { ExperimentResultV1, HarnessVersion, LearningStateV1 } from '../../../../core/learn/harness-types.js';
import { harnessActionOutcome, rollbackTarget, runningExperiments } from './harness-actions-model.js';

const version = (id: string, status = 'active') => ({ id, status }) as HarnessVersion;
const experiment = (id: string, status: ExperimentResultV1['status']) => ({ id, status }) as ExperimentResultV1;
const state = (active: HarnessVersion | null, versions: HarnessVersion[] = [], experiments: ExperimentResultV1[] = []) => ({ active, versions, experiments }) as LearningStateV1;

describe('harness actions model', () => {
  it('targets baseline or the preceding version', () => {
    const baseline = version('base', 'baseline');
    const first = version('h-1');
    const second = version('h-2');
    expect(rollbackTarget(state(null))).toBeNull();
    expect(rollbackTarget(state(first, [first]))).toEqual({ toVersionId: null, label: 'Baseline' });
    expect(rollbackTarget(state(first, [baseline, first]))).toEqual({ toVersionId: null, label: 'Baseline' });
    expect(rollbackTarget(state(second, [baseline, first, second]))).toEqual({ toVersionId: 'h-1', label: 'h-1' });
  });
  it('finds queued and running experiments', () => {
    expect(runningExperiments(state(null, [], [experiment('a', 'queued'), experiment('b', 'running'), experiment('c', 'done'), experiment('d', 'cancelled'), experiment('e', 'failed')])).map(e => e.id)).toEqual(['a', 'b']);
  });
  it('explains every outcome', () => {
    expect(harnessActionOutcome(200)).toBe('Harness change complete.');
    for (const status of [401, 403]) expect(harnessActionOutcome(status)).toBe('Unlock to change the harness.');
    expect(harnessActionOutcome(404)).toBe('This Phantom build cannot change the harness from the app.');
    expect(harnessActionOutcome(409, 'Refused.')).toBe('Refused.');
    expect(harnessActionOutcome(409)).toBe('Could not do that. Try again.');
    expect(harnessActionOutcome(500)).toBe('Could not do that. Try again.');
  });
});
