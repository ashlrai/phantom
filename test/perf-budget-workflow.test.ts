/**
 * Perf Budget workflow policy (RQ-PERF-9).
 *
 * .github/workflows/perf-budget.yml is an advisory, non-required check. It may
 * only ever run on pull_request, the daily drift schedule and manual dispatch
 * — never merge_group, push, pull_request_target or workflow_run — stays
 * read-only, and pins every action to a reviewed immutable commit. A
 * regression fails the job outright (no continue-on-error); that is safe
 * precisely because the check can never become required by shape. Pure
 * workflow assertions: no network, credentials, or runner effects.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const workflowText = readFileSync(resolve(repoRoot, '.github/workflows/perf-budget.yml'), 'utf8');
const workflow = parse(workflowText) as Record<string, unknown>;
const on = workflow.on as Record<string, unknown>;
const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
const job = jobs['perf-budget']!;
const steps = job.steps as Array<Record<string, unknown>>;

// The reviewed immutable action commits (same set test/m481 pins for ci.yml).
const approvedActions = new Set([
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
]);

const actionRefs = steps.flatMap((step) => (typeof step.uses === 'string' ? [step.uses] : []));
const runStep = (name: string): Record<string, unknown> | undefined =>
  steps.find((step) => step.name === name);

describe('perf-budget workflow is advisory by shape', () => {
  it('runs only on pull_request, the daily drift schedule and manual dispatch', () => {
    expect(Object.keys(on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    expect(on.pull_request).toEqual({ branches: ['**'], types: ['opened', 'synchronize', 'reopened'] });
    expect(on.schedule).toEqual([{ cron: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }]);
    // A merge_group, push, pull_request_target or workflow_run trigger would
    // let the check reach merge-queue or protected refs — it must never get
    // close enough to the gate to be made required.
    for (const forbidden of ['merge_group', 'push', 'pull_request_target', 'workflow_run']) {
      expect(on, `trigger ${forbidden}`).not.toHaveProperty(forbidden);
    }
    // The job also never joins the Merge Gate needs graph.
    expect(Object.keys(jobs)).toEqual(['perf-budget']);
    expect(job).not.toHaveProperty('needs');
  });

  it('is read-only and never widens the token', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job).not.toHaveProperty('permissions');
    expect(workflowText).not.toMatch(/secrets\.|id-token|persist-credentials:\s*true/);
    const checkout = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
    expect(checkout?.with).toMatchObject({ 'persist-credentials': false });
  });

  it('names the check so its advisory status is visible on the PR', () => {
    expect(job.name).toMatch(/advisory/i);
    expect(job.name).toMatch(/non-required/i);
  });
});

describe('perf-budget workflow measures with hyperfine and really fails', () => {
  it('pins every action to a reviewed immutable commit', () => {
    expect(actionRefs.length).toBeGreaterThan(0);
    for (const ref of actionRefs) {
      expect(ref, `mutable action ref: ${ref}`).toMatch(
        /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}$/i,
      );
      expect(approvedActions.has(ref), `unapproved action ref: ${ref}`).toBe(true);
    }
  });

  it('builds dist/ before timing on a cheap Ubuntu runner', () => {
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    const setup = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/setup-node@'));
    expect(setup?.with).toMatchObject({ 'node-version': '22.22.3' });
    const buildIdx = steps.findIndex((step) => typeof step.run === 'string' && step.run.includes('npm run build'));
    const measureIdx = steps.findIndex((step) => typeof step.run === 'string' && step.run.includes('scripts/perf-budget.mjs'));
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(measureIdx).toBeGreaterThan(buildIdx);
  });

  it('times the committed budgets with hyperfine on a fresh HOME and fails on regression', () => {
    const measure = runStep('Run the perf budget check');
    expect(measure).toBeDefined();
    expect(measure!.run).toContain('scripts/perf-budget.mjs');
    expect(measure!.run).toContain('--runner hyperfine');
    expect(measure!.run).toContain('--home');
    expect(measure!.run).toContain('--json');
    // The check must actually fail on a regression: continue-on-error would
    // turn a real slowdown into a green check and make the workflow a no-op.
    expect(measure).not.toHaveProperty('continue-on-error');
    expect(job).not.toHaveProperty('continue-on-error');
    expect(measure).not.toHaveProperty('if');
  });

  it('publishes the JSON report as baseline-refresh evidence', () => {
    const report = runStep('Run the perf budget check')!.run as string;
    expect(report).toContain('perf-budget-report.json');
    const upload = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'));
    expect(upload).toBeDefined();
    expect(upload!.with).toMatchObject({
      path: 'perf-budget-report.json',
      'if-no-files-found': 'ignore',
    });
    expect(upload!.if).toBe('always()');
  });
});
