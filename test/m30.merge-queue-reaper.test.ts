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
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const text = readFileSync(resolve(repoRoot, '.github/workflows/merge-queue-reaper.yml'), 'utf8');
const wf = parse(text) as Record<string, any>;
const ci = parse(readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as Record<string, any>;
const jobs = wf.jobs as Record<string, any>;
const job = jobs['reap-orphaned-merge-group-runs'];
const script: string = job.steps[0].run;

// Run the committed script with fake curl (returns scripted HTTP codes in
// order) and fake gh (one queued run 1, records cancels). Returns cancelled ids.
function runStubbed(codes: string[], headBranch: string): string[] {
  const dir = mkdtempSync(resolve(tmpdir(), 'reaper-'));
  writeFileSync(resolve(dir, 'codes'), codes.join('\n') + '\n');
  writeFileSync(resolve(dir, 'curl'), `#!/usr/bin/env bash
n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"
c=$(sed -n "\${n}p" "${dir}/codes")
[ "$c" = FAIL ] && exit 7
[ -z "$c" ] && c=200
printf '%s' "$c"
[ "$c" = 000 ] && exit 6
exit 0
`);
  writeFileSync(resolve(dir, 'gh'), `#!/usr/bin/env bash
if [ "$1 $2" = "api -X" ]; then echo "$4" | sed -E 's#.*/runs/([0-9]+)/cancel#\\1#' >> "${dir}/cancelled"; exit 0; fi
case "$*" in *status=queued*) printf '1\\t%s\\n' "$HEAD_BRANCH" ;; esac
`);
  chmodSync(resolve(dir, 'curl'), 0o755);
  chmodSync(resolve(dir, 'gh'), 0o755);
  execFileSync('bash', ['-c', script], {
    env: { PATH: `${dir}:/usr/bin:/bin`, GH_TOKEN: 't', REPO: 'o/r', SELF_RUN_ID: '999', HEAD_BRANCH: headBranch },
  });
  try {
    return readFileSync(resolve(dir, 'cancelled'), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

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
    expect(script).toContain('=~ ^gh-readonly-queue/');
    expect(script).toContain('SELF_RUN_ID');
  });

  it('validates head_branch against the queue ref pattern before any API call', () => {
    expect(script).toContain('^gh-readonly-queue/[A-Za-z0-9._/-]+$');
    expect(script.indexOf('gh-readonly-queue/[A-Za-z0-9')).toBeLessThan(script.indexOf('ref_status "${head_branch}"'));
  });

  it('cancels only on an explicit HTTP 404 from both checks', () => {
    expect(script).toContain("%{http_code}");
    expect(script.match(/!= "404" \]; then\s+echo "keep/g)?.length).toBe(2);
    expect(script).not.toMatch(/--silent >\/dev\/null 2>&1\s*\n\s*}/);
  });

  describe('executed with stubbed curl and gh', () => {
    const cases: Array<[string, string[], string[]]> = [
      ['404 then 404 cancels', ['404', '404'], ['1']],
      ['404 then 200 keeps', ['404', '200'], []],
      ['200 keeps', ['200'], []],
      ['403 rate limit keeps', ['403'], []],
      ['500 keeps', ['500'], []],
      ['502 on re-check keeps', ['404', '502'], []],
      ['network error keeps', ['000'], []],
      ['curl failure with no output keeps', ['FAIL'], []],
    ];
    for (const [label, codes, expected] of cases) {
      it(label, () => expect(runStubbed(codes, 'gh-readonly-queue/master/pr-1-abc')).toEqual(expected));
    }
    it('skips malformed head refs without calling the refs API', () => {
      expect(runStubbed(['404', '404'], 'gh-readonly-queue/master/../x?y')).toEqual([]);
      expect(runStubbed(['404', '404'], 'feature/branch')).toEqual([]);
    });
  });

  it('keys any concurrency on the per-entry ref, never workflow plus base alone', () => {
    expect(wf.concurrency.group).toContain('${{ github.ref }}');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });
});
