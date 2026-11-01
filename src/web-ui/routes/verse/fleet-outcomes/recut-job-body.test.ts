import { expect, it } from 'vitest';
import type { OutcomeCaseRow } from './fleet-outcomes-model.js';
import { recutJob } from './recut-job-body.js';

const row: OutcomeCaseRow = {
  caseId: 'RQ-PHX-EXAMPLE31', jobId: 'RQ-PHX-EXAMPLE31', endedAt: null,
  outcome: 'failed', lane: 'codex-personal', label: 'Conflicting PR', failureKind: 'DIRTY',
  proposalRecorded: true, prLink: { url: 'https://github.com/ashlrai/phantom/pull/1234', label: '#1234' },
};
const now = Date.parse('2026-11-01T00:10:00Z');

it('builds a deterministic dispatch ID, exact header and complete recut recipe', () => {
  const job = recutJob(row, now)!;
  expect(job.id).toBe('RECUT12341101');
  expect(job.id).toMatch(/^[A-Z0-9]{3,40}$/);
  expect(job.lane).toBe('codex-personal');
  expect(job.tier).toBe('work');
  expect(job.body.split('\n')[0]).toBe('#job repo=phantom lane=codex-personal tier=work');
  expect(new TextEncoder().encode(job.body).length).toBeLessThan(6000);
  for (const text of [
    'land the finished work of PR #1234 (RQ-PHX-EXAMPLE31) on current master as one new PR',
    'git fetch origin master && git fetch origin pull/1234/head:recut-1234',
    'drop hunks already on master', 'src/cli/fleet.ts', 'src/cli/index.ts', 'src/cli/help.ts',
    'src/cli/completions.ts', 'docs/README.md', 'src/cli/fleet-<name>.ts', 'at least one new test file',
    'node scripts/verify-changed.mjs once', 'Leave changes uncommitted', 'BRIDGE_NOTES.md',
    'Conflicting PR', 'DIRTY',
  ]) expect(job.body).toContain(text);
  expect(job.body).toMatch(/^Closes #1234$/m);
});

it('pads UTC month and day', () => {
  expect(recutJob(row, Date.parse('2026-01-02T23:00:00-05:00'))?.id).toBe('RECUT12340103');
});

it('keeps large Unicode context under the byte limit', () => {
  const job = recutJob({ ...row, label: '😀'.repeat(8000), failureKind: '😀'.repeat(8000) }, now)!;
  expect(new TextEncoder().encode(job.body).length).toBeLessThan(6000);
});

it.each([null, { url: 'https://github.com/ashlrai/phantom', label: 'PR' },
  { url: 'https://github.com/ashlrai/phantom/pull/0', label: '#0' },
  { url: 'https://github.com/ashlrai/phantom/pull/123oops', label: 'bad' }])('requires a parsed positive PR number: %j', prLink => {
  expect(recutJob({ ...row, prLink }, now)).toBeNull();
});
