/**
 * Merge queue reaper contract: cancels only orphaned merge_group runs.
 *
 * Pure workflow assertions. A run may be cancelled only after its
 * gh-readonly-queue ref is confirmed gone, twice. Permissions stay minimal and
 * the job can never fail or shadow a required check.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const text = readFileSync(resolve(repoRoot, '.github/workflows/merge-queue-reaper.yml'), 'utf8');
const wf = parse(text) as Record<string, any>;
const ci = parse(readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as Record<string, any>;
const jobs = wf.jobs as Record<string, any>;
const job = jobs['reap-orphaned-merge-group-runs'];
const script: string = job.steps[0].run;

describe('merge queue reaper', () => {
  it('has a single job with minimal permissions', () => {
    expect(Object.keys(jobs)).toEqual(['reap-orphaned-merge-group-runs']);
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toEqual({ actions: 'write', contents: 'read' });
  });

  it('uses no third-party actions and no secrets beyond GITHUB_TOKEN', () => {
    expect(text).not.toMatch(/\buses:/);
    expect(text).not.toMatch(/secrets\./);
    expect(job.steps[0].env.GH_TOKEN).toBe('${{ github.token }}');
  });

  it('can never fail and is time boxed', () => {
    expect(job['continue-on-error']).toBe(true);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(5);
    expect(script.trimEnd().endsWith('exit 0')).toBe(true);
    expect(script).not.toMatch(/set -e/);
  });

  it('does not reuse any required CI job name', () => {
    const ciNames = new Set(
      Object.entries(ci.jobs as Record<string, any>).flatMap(([id, j]) => [id, j.name].filter(Boolean)),
    );
    expect(ciNames.has(job.name)).toBe(false);
    expect(ciNames.has('reap-orphaned-merge-group-runs')).toBe(false);
  });

  it('only targets merge_group runs on gh-readonly-queue refs', () => {
    expect(script).toContain('event=merge_group');
    expect(script).toContain('gh-readonly-queue/*) ;; *) continue');
    expect(script).toContain('SELF_RUN_ID');
  });

  it('checks the per-entry ref exists twice before any cancel', () => {
    expect(script).toContain('git/ref/heads/$1');
    const cancelAt = script.indexOf('/cancel"');
    expect(cancelAt).toBeGreaterThan(0);
    const before = script.slice(0, cancelAt);
    const guards = before.match(/if ref_exists "\$\{head_branch\}"; then\s+echo "keep[^\n]*\n\s+continue/g) ?? [];
    expect(guards.length).toBe(2);
  });

  it('keys any concurrency on the per-entry ref, never workflow plus base alone', () => {
    expect(wf.concurrency.group).toContain('${{ github.ref }}');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });
});
