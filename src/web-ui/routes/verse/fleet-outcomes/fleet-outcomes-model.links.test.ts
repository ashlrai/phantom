import { describe, expect, it } from 'vitest';
import { readOutcomes } from './fleet-outcomes-model.js';

const row = (item: Record<string, unknown>) => readOutcomes({
  v: 1, state: 'current', feedback: { sourceState: 'healthy', cases: [item] },
})!.cases[0]!;

describe('outcome case links', () => {
  it('uses the shared worker job identifier validator', () => {
    expect(row({ caseId: 'RQ-PHX-EXAMPLE31' }).jobId).toBe('RQ-PHX-EXAMPLE31');
    expect(row({ caseId: 'h:0000000000000001:0000000000000002:0000000000000003:0000000000000004' }).jobId).toBeNull();
    // The shared validator accepts generic job IDs, including case-7.
    expect(row({ caseId: 'case-7' }).jobId).toBe('case-7');
  });

  it('links a recorded PR number or a GitHub timeline URL', () => {
    expect(row({ caseId: 'job', prNumber: 1234 }).prLink).toEqual({
      url: 'https://github.com/ashlrai/phantom/pull/1234', label: '#1234',
    });
    expect(row({ caseId: 'job', timeline: [{ stage: 'pr-opened', href: 'https://github.com/example/repo/pull/7' }] }).prLink)
      .toEqual({ url: 'https://github.com/example/repo/pull/7', label: '#7' });
  });

  it('rejects unsafe or non-PR URLs even when a number is present', () => {
    expect(row({ caseId: 'job', href: 'https://example.com/ashlrai/phantom/pull/1234', prNumber: 1234 }).prLink).toBeNull();
    expect(row({ caseId: 'job', href: 'https://github.com/ashlrai/phantom/issues/1234' }).prLink).toBeNull();
    expect(row({ caseId: 'job', prNumber: 0 }).prLink).toBeNull();
  });
});
