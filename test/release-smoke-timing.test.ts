/**
 * release-smoke-timing — the Desktop release smoke tracker reads API rows only
 * and appends deterministically (RQ-RELEASE-ISOLATED-BUILD-1). Hermetic: an
 * injected reader stands in for `gh api`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  JOB_NAME,
  appendTracked,
  collectSmokeRuns,
  quantile,
  smokeRow,
  summarize,
} from '../scripts/release-smoke-timing.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const step = (number: number, name: string, conclusion: string) => ({ number, name, conclusion });
const run = (id: number, extra: Record<string, unknown> = {}) => ({
  id, run_attempt: 1, event: 'schedule', head_branch: 'master', head_sha: 'a'.repeat(40), ...extra,
});
const job = (started: string, completed: string, conclusion: string, steps: unknown[]) => ({
  name: JOB_NAME, status: 'completed', conclusion, started_at: started, completed_at: completed, steps,
});
const built = (conclusion = 'success') => [
  step(11, 'Build unsigned desktop and original package once', conclusion === 'success' ? 'success' : 'failure'),
  step(16, 'Smoke desktop release artifact', conclusion === 'success' ? 'success' : 'skipped'),
];

describe('release smoke rows', () => {
  it('classifies built, reused, no-op and skipped jobs', () => {
    expect(smokeRow(run(1), job('2026-11-09T00:00:00Z', '2026-11-09T00:06:36Z', 'success', built()))).toMatchObject({
      runId: 1, seconds: 396, result: 'success', path: 'built', failedStep: '',
    });
    expect(smokeRow(run(2), job('2026-11-09T00:00:00Z', '2026-11-09T00:01:00Z', 'success', [
      step(6, 'Download existing immutable build', 'success'), step(11, 'Build unsigned desktop and original package once', 'skipped'),
      step(16, 'Smoke desktop release artifact', 'success'),
    ]))).toMatchObject({ path: 'reused', seconds: 60 });
    expect(smokeRow(run(3), job('2026-11-09T00:00:00Z', '2026-11-09T00:06:00Z', 'failure', built('failure'))))
      .toMatchObject({ result: 'failure', failedStep: '11: Build unsigned desktop and original package once' });
    // Eligibility no-op: green, nothing built, downloaded or smoked.
    expect(smokeRow(run(4), job('2026-11-09T00:00:00Z', '2026-11-09T00:00:17Z', 'success', [
      step(3, 'Reuse successful push CI and existing prepared artifact', 'success'),
      step(11, 'Build unsigned desktop and original package once', 'skipped'),
    ]))).toBeNull();
    // A failure before the build is still a failed smoke attempt.
    expect(smokeRow(run(5), job('2026-11-09T00:00:00Z', '2026-11-09T00:00:10Z', 'failure', [
      step(3, 'Reuse successful push CI and existing prepared artifact', 'failure'),
    ]))).toMatchObject({ path: 'none', result: 'failure' });
    expect(smokeRow(run(6), { ...job('', '', 'skipped', []) })).toBeNull();
    expect(smokeRow(run(7), undefined)).toBeNull();
  });

  it('matches the CI Efficiency baseline statistics (median and linear p95)', () => {
    const durations = [390, 413, 450, 257, 467, 458, 392, 257, 380, 401];
    expect(quantile(durations, 0.5)).toBe(396.5);
    expect(quantile(durations, 0.95)).toBeCloseTo(462.95, 5);
    const rows = durations.map((seconds, i) => ({ seconds, result: i >= 5 && i !== 8 ? 'success' : 'failure' }));
    expect(summarize(rows)).toEqual({ runs: 10, passes: 4, median: '396.5 s', p95: '462.9 s' });
    expect(summarize([])).toEqual({ runs: 0, passes: 0, median: 'n/a', p95: 'n/a' });
  });

  it('collects only release smoke attempts through the injected reader, newest first', () => {
    const reads: string[] = [];
    const rows = collectSmokeRuns({ perEvent: 5, read: (endpoint: string) => {
      reads.push(endpoint);
      if (endpoint.includes('event=workflow_dispatch')) return { workflow_runs: [run(10, { event: 'workflow_dispatch', head_branch: 'v3.30.28' })] };
      if (endpoint.includes('event=schedule')) return { workflow_runs: [run(11), run(12)] };
      if (endpoint.includes('/runs/10/')) return { jobs: [job('2026-11-09T02:00:00Z', '2026-11-09T02:07:00Z', 'success', built())] };
      if (endpoint.includes('/runs/11/')) return { jobs: [{ name: 'Merge Gate', status: 'completed', conclusion: 'success' }] };
      return { jobs: [job('2026-11-09T01:00:00Z', '2026-11-09T01:05:00Z', 'failure', built('failure'))] };
    } });
    expect(rows.map((row: { runId: number }) => row.runId)).toEqual([10, 12]);
    expect(reads[0]).toBe('repos/ashlrai/phantom/actions/workflows/ci.yml/runs?event=workflow_dispatch&status=completed&per_page=5');
    expect(reads).toContain('repos/ashlrai/phantom/actions/runs/12/attempts/1/jobs?per_page=100');
  });
});

describe('tracked table append', () => {
  const doc = readFileSync(join(REPO_ROOT, 'docs/release/SMOKE-TIMING.md'), 'utf8');
  const newer = (id: number, startedAt: string, result = 'success') => ({
    runId: id, attempt: 1, event: 'workflow_dispatch', ref: 'v3.30.31', sha: 'b'.repeat(40), startedAt,
    seconds: 150, result, path: 'built', failedStep: result === 'success' ? '' : '11: Build unsigned desktop and original package once',
  });

  it('starts empty and appends only newer, unnamed attempts in start order', () => {
    expect(doc).toContain('Tracked 0 of the next 5 release smokes: pass 0/0, median n/a, p95 n/a.');
    const baselineRow = { ...newer(42737802873, '2026-11-10T01:43:51Z', 'failure') };
    const first = appendTracked(doc, [newer(50000000002, '2026-11-11T02:00:00Z'), newer(50000000001, '2026-11-11T01:00:00Z', 'failure'), baselineRow]);
    expect(first.added).toBe(2);
    const block = first.doc.slice(first.doc.indexOf('<!-- smoke-timing:tracked:start -->'));
    expect(block.indexOf('50000000001')).toBeLessThan(block.indexOf('50000000002'));
    expect(block).toContain('Tracked 2 of the next 5 release smokes: pass 1/2, median 150 s, p95 150 s.');
    // Idempotent: the same API rows add nothing and leave the doc byte-identical.
    const again = appendTracked(first.doc, [newer(50000000002, '2026-11-11T02:00:00Z'), newer(50000000001, '2026-11-11T01:00:00Z', 'failure')]);
    expect(again).toEqual({ doc: first.doc, added: 0 });
    expect(first.doc.slice(0, first.doc.indexOf('<!-- smoke-timing:tracked:start -->')))
      .toBe(doc.slice(0, doc.indexOf('<!-- smoke-timing:tracked:start -->')));
  });

  it('refuses a doc without tracked markers', () => {
    expect(() => appendTracked('# no markers\n', [])).toThrow(/markers/);
  });
});
