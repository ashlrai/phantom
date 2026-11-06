import { describe, expect, it } from 'vitest';
import type { UpdateServerStatus } from '../sections/update-status-queries.js';
import { newerVersion, pollingDue, postMergeLine, type MergeNotice } from './post-merge-update-model.js';

const notice: MergeNotice = { number: 2345, label: 'Merged', mergedAt: 1_000_000 };
const status = (candidateVersion: string, installedVersion = '3.29.15') => ({
  v: 1, sourceState: 'healthy', installedVersion, candidateVersion,
} as UpdateServerStatus & { candidateVersion: string });

describe('post-merge update', () => {
  it('shows the merge until a newer candidate is reported', () => {
    expect(postMergeLine(undefined, undefined, 0)).toBeNull();
    expect(postMergeLine({ number: null, label: 'refused', mergedAt: null }, undefined, 0)).toBeNull();
    const merged = 'Release PR #2345 merged 2 min ago. The tag workflow runs next; the update appears here when the release is published.';
    expect(postMergeLine(notice, undefined, 1_120_000)).toBe(merged);
    expect(postMergeLine(notice, status('3.29.15'), 1_120_000)).toBe(merged);
    expect(postMergeLine(notice, status('3.30.0'), 1_120_000)).toBe('3.30.0 is ready (running 3.29.15).');
  });
  it('only reports a successful apply after this merge', () => {
    const lastApply = { outcome: 'updated', finishedAt: new Date(1_000_001).toISOString() } as NonNullable<UpdateServerStatus['lastApply']>;
    expect(postMergeLine(notice, { ...status('3.30.0'), lastApply }, 1_120_000)).toBe('Update applied; restart when convenient.');
    expect(postMergeLine(notice, { ...status('3.30.0'), lastApply: { ...lastApply, finishedAt: new Date(999_999).toISOString() } }, 1_120_000)).toContain('3.30.0 is ready');
  });
  it.each([
    ['3.30.0', '3.29.15', true], ['3.29.15', '3.29.15', false], ['3.29.9', '3.29.15', false],
    ['1.0.0', '1.0.0-rc.1', true], ['1.0.0-rc.1', '1.0.0', false],
    ['1.0.0-rc.10', '1.0.0-rc.2', true], ['1.0.0-alpha.1', '1.0.0-alpha', true],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', false], ['1.0.0+new', '1.0.0+old', false],
    ['1.0.0-01', '1.0.0-alpha', false], ['v3.30.0', '3.29.15', false],
  ])('compares %s against %s', (candidate, current, expected) => expect(newerVersion(candidate, current)).toBe(expected));
  it('stops polling at 45 minutes', () => {
    expect(pollingDue(undefined, 0)).toBe(false);
    expect(pollingDue(notice, notice.mergedAt! + 45 * 60_000 - 1)).toBe(true);
    expect(pollingDue(notice, notice.mergedAt! + 45 * 60_000)).toBe(false);
  });
});
