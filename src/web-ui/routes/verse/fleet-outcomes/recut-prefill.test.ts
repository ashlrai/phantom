import { describe, expect, it } from 'vitest';
import { isWasteCase, recutPrefill, type OutcomeCaseRow } from './fleet-outcomes-model.js';

const row: OutcomeCaseRow = {
  caseId: 'RQ-PHX-EXAMPLE31', jobId: 'RQ-PHX-EXAMPLE31', endedAt: null,
  outcome: 'failed', lane: 'codex-personal', label: 'Failed', failureKind: 'test failure',
  proposalRecorded: true, prLink: { url: 'https://github.com/ashlrai/phantom/pull/1234', label: '#1234' },
};

describe('recut orders', () => {
  it('includes the job, cause, PR and fork pull ref', () => {
    expect(recutPrefill(row)).toBe('Recut RQ-PHX-EXAMPLE31 (codex-personal): test failure — Failed. PR #1234. Inherit with git fetch origin pull/1234/head.');
  });

  it('uses fallback details and omits inheritance without a PR', () => {
    expect(recutPrefill({ ...row, lane: undefined, failureKind: null, prLink: null }))
      .toBe('Recut RQ-PHX-EXAMPLE31 (lane unknown): Failed — Failed. PR none.');
  });

  it('omits inheritance if a PR link has no pull number', () => {
    expect(recutPrefill({ ...row, prLink: { url: 'https://github.com/ashlrai/phantom', label: 'PR' } }))
      .toBe('Recut RQ-PHX-EXAMPLE31 (codex-personal): test failure — Failed. PR PR.');
  });

  it.each(['empty-diff', 'refused', 'failed', 'cancelled'] as const)('treats %s as waste', outcome => {
    expect(isWasteCase({ ...row, outcome })).toBe(true);
  });

  it.each(['producer-succeeded', 'disabled', 'unknown'] as const)('does not order a recut for %s', outcome => {
    expect(isWasteCase({ ...row, outcome })).toBe(false);
    expect(recutPrefill({ ...row, outcome })).toBeNull();
  });

  it('cannot order a recut without a job ID', () => {
    expect(recutPrefill({ ...row, jobId: null })).toBeNull();
  });
});
