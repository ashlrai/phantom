/**
 * RQ-PH-GATE-SPLIT-1: Auto-tag must refuse a sha unless "Check generated files"
 * and "Check authority drift (hermetic)" are completed + success on that exact
 * sha, in addition to every ruleset-required check (Merge Gate). v3.30.34 was
 * tagged while "Check generated files" had failed on the tagged commit.
 *
 * The real workflow step is executed under bash with a stubbed `gh` and `sleep`
 * (hermetic: no network, no real token).
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '..');
const workflow = parse(readFileSync(resolve(repoRoot, '.github/workflows/auto-tag.yml'), 'utf8')) as {
  on: Record<string, unknown>;
  jobs: { tag: { permissions: Record<string, string>; steps: { id?: string; name?: string; run?: string }[] } };
};
const step = workflow.jobs.tag.steps.find((entry) => entry.id === 'checks')!;
const GEN = 'Check generated files';
const DRIFT = 'Check authority drift (hermetic)';

type Run = { name: string; status?: string; conclusion?: string | null; app?: number };

function runStep(runs: Run[], trigger = 'schedule') {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tag-split-'));
  try {
    const rows = runs.map((r) => [r.name, r.status ?? 'completed', r.conclusion ?? '', r.app ?? 15368].join('\t')).join('\n');
    writeFileSync(join(dir, 'rows.tsv'), rows);
    // gh stub: rules API lists Merge Gate only; classic protection lists nothing;
    // the check-runs call prints the fixture rows for app 15368 only (the real
    // jq filter is bypassed, so honour the app filter here).
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash
case "$*" in
  *rules/branches*) echo "Merge Gate" ;;
  *"branches/master"*) ;;
  *check-runs*) awk -F'\\t' '$4==15368 {print $1"\\t"$2"\\t"$3}' "${dir}/rows.tsv" ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
`);
    writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(dir, 'gh'), 0o755);
    chmodSync(join(dir, 'sleep'), 0o755);
    const out = join(dir, 'output');
    writeFileSync(out, '');
    const result = spawnSync('bash', ['-c', step.run!], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: out, REPO: 'ashlrai/phantom', BRANCH: 'master',
        SHA: 'a'.repeat(40), TRIGGER: trigger, SKIP_OK: '', ACTIONS_APP_ID: '15368', GH_TOKEN: 'stub',
      },
    });
    return { status: result.status, output: readFileSync(out, 'utf8'), log: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ok = (name: string): Run => ({ name, conclusion: 'success' });
const allGreen = [ok('Merge Gate'), ok(GEN), ok(DRIFT)];

describe('Auto-tag requires both split checks on the exact sha', { timeout: 60_000 }, () => {
  it('tags only when Merge Gate and both new checks are success', () => {
    const result = runStep(allGreen);
    expect(result.status, result.log).toBe(0);
    expect(result.output).toContain('green=true');
  });

  it.each([GEN, DRIFT])('refuses %s when it failed, was skipped, or is neutral/cancelled', (name) => {
    for (const conclusion of ['failure', 'skipped', 'neutral', 'cancelled', 'timed_out']) {
      const runs = allGreen.map((r) => (r.name === name ? { name, conclusion } : r));
      const result = runStep(runs);
      expect(result.status, `${name} ${conclusion}`).not.toBe(0);
      expect(result.output, `${name} ${conclusion}`).not.toContain('green=true');
    }
  });

  it.each([GEN, DRIFT])('never tags while %s is missing, queued or in progress', (name) => {
    const missing = runStep(allGreen.filter((r) => r.name !== name));
    expect(missing.output).not.toContain('green=true');
    expect(missing.log).toContain(`missing: ${name}`);
    // push trigger: bounded wait ends in a notice (no tag); workflow_run/schedule fails.
    expect(missing.status).toBe(1);
    const missingPush = runStep(allGreen.filter((r) => r.name !== name), 'push');
    expect(missingPush.output).toContain('green=false');
    for (const status of ['queued', 'in_progress']) {
      const pending = runStep(allGreen.map((r) => (r.name === name ? { name, status, conclusion: null } : r)));
      expect(pending.status, status).toBe(1);
      expect(pending.output).not.toContain('green=true');
    }
  });

  it('ignores same-named check runs from another app', () => {
    const forged = allGreen.map((r) => (r.name === GEN ? { name: GEN, conclusion: 'success', app: 1 } : r));
    expect(runStep(forged).output).not.toContain('green=true');
  });

  it('refuses when Merge Gate is not green even if both new checks are', () => {
    const result = runStep([{ name: 'Merge Gate', conclusion: 'failure' }, ok(GEN), ok(DRIFT)]);
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('green=true');
  });

  it('adds no trigger, secret or permission for the new check', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'schedule', 'workflow_dispatch', 'workflow_run']);
    expect(workflow.jobs.tag.permissions).toEqual({ contents: 'read', checks: 'read', actions: 'write' });
    expect(step.run).not.toMatch(/secrets\./);
  });
});
