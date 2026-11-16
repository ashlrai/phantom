import { describe, expect, it } from 'vitest';
import { parseArmSnapshot, predictArmConflict } from '../src/core/fleet/merge-arm-conflict.js';

const rows = (...r: Array<[number, string[], boolean?]>) => parseArmSnapshot(r.map(([number, files, armed]) =>
  ({ number, isDraft: false, autoMergeRequest: armed ? {} : null, files: files.map(path => ({ path })) })));

describe('merge-arm-conflict', () => {
  it('predicts overlap with armed PRs and reports bounded evidence', () => {
    expect(predictArmConflict(1, rows([1, ['a', 'b']], [2, ['b', 'z'], true], [3, ['q'], true]))).toEqual(
      { state: 'predicted-conflict', with: [2], shared: ['b'] });
  });
  it('is clear without overlap and unknown without evidence', () => {
    expect(predictArmConflict(1, rows([1, ['a']], [2, ['b'], true]))).toEqual({ state: 'clear' });
    expect(predictArmConflict(1, rows([2, ['b'], true]))).toEqual({ state: 'unknown' });
    expect(predictArmConflict(1, null)).toEqual({ state: 'unknown' });
  });
  it('rejects malformed snapshots', () => {
    expect(parseArmSnapshot({})).toBeNull();
    expect(parseArmSnapshot([{ number: 1 }])).toBeNull();
  });
});
