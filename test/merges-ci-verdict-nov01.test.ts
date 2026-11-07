import { describe, expect, it } from 'vitest';
import { ciVerdictCounts, ciVerdictForBranch, type CiRunFactsV1 } from '../src/web-ui/routes/verse/fleet-merges/merges-ci-verdict.js';

type Run = CiRunFactsV1['recent'][number];
const run = (overrides: Partial<Run> = {}): Run => ({
  runId: 1, workflow: 'CI', event: 'pull_request', headBranch: 'feature', prNumber: 42,
  conclusion: 'success', status: 'completed', failureClass: null,
  createdAt: '2026-11-01T00:00:00Z', url: 'https://github.com/acme/widgets/actions/runs/1', ...overrides,
});

describe('merge CI verdicts', () => {
  it.each([
    [run(), 'ok', 'CI green'],
    [run({ status: 'queued', conclusion: null }), 'running', 'CI running'],
    [run({ status: 'in_progress', conclusion: null }), 'running', 'CI running'],
    [run({ conclusion: 'failure', failureClass: 'bind-artifact' }), 'artifact', 'CI red: rebase artifact, not code'],
    [run({ conclusion: 'failure', failureClass: 'code' }), 'code', 'CI red: code'],
    [run({ conclusion: 'failure' }), 'code', 'CI red'],
    [run({ conclusion: 'cancelled' }), 'none', ''],
  ] as const)('classifies %o', (entry, tone, label) => {
    expect(ciVerdictForBranch([entry], 'feature', 42)).toEqual({ tone, label, url: entry.url, runId: entry.runId });
  });

  it('prefers PR matches over newer branch matches and chooses the newest matching run', () => {
    const older = run({ runId: 1, headBranch: 'old' });
    const newer = run({ runId: 2, headBranch: 'old', createdAt: '2026-11-01T01:00:00Z' });
    const branch = run({ runId: 3, prNumber: null, createdAt: '2026-11-01T02:00:00Z' });
    expect(ciVerdictForBranch([older, branch, newer], 'feature', 42).runId).toBe(2);
    expect(ciVerdictForBranch([older, branch, newer], 'feature', 99).runId).toBe(3);
    expect(ciVerdictForBranch([older], '', null).runId).toBeNull();
    expect(ciVerdictForBranch(undefined, 'feature', 42)).toEqual({ tone: 'none', label: '', url: null, runId: null });
  });

  it('counts verdicts by row', () => {
    const rows = [run(), run({ conclusion: 'failure', failureClass: 'bind-artifact' }), run({ conclusion: 'failure', failureClass: null }), run({ status: 'queued' })]
      .map(entry => ciVerdictForBranch([entry], 'feature', 42));
    expect(ciVerdictCounts(rows)).toBe('1 green, 1 artifact reds, 1 code reds');
  });
});
