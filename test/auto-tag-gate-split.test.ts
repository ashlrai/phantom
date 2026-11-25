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
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '..');
type WorkflowStep = { id?: string; name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string> };
const workflow = parse(readFileSync(resolve(repoRoot, '.github/workflows/auto-tag.yml'), 'utf8')) as {
  on: Record<string, unknown>;
  concurrency: { group: string };
  jobs: { tag: { if: string; permissions: Record<string, string>; env: Record<string, string>; steps: WorkflowStep[] } };
};
const step = workflow.jobs.tag.steps.find((entry) => entry.id === 'checks')!;
const validateShaStep = workflow.jobs.tag.steps.find((entry) => entry.id === 'validate-dispatch-sha')!;
const versionStep = workflow.jobs.tag.steps.find((entry) => entry.id === 'version')!;
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

function runVersionStep(newVersion: string, oldVersion: string, subject: string) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tag-version-'));
  try {
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"parents[0].sha"* ]]; then
  printf 'parent\\n'
elif [[ "$*" == *"commit.message"* ]]; then
  printf '%s\\n' "$SUBJECT"
elif [[ "$*" == *"contents/package.json?ref=$SHA"* ]]; then
  printf '{"version":"%s"}\\n' "$NEW_VERSION"
elif [[ "$*" == *"contents/package.json?ref=parent"* ]]; then
  printf '{"version":"%s"}\\n' "$OLD_VERSION"
else
  echo "unexpected gh $*" >&2
  exit 9
fi
`);
    writeFileSync(join(dir, 'jq'), `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => { console.log(JSON.parse(input).version); });
`);
    writeFileSync(join(dir, 'git'), '#!/usr/bin/env bash\nexit 2\n');
    for (const name of ['gh', 'jq', 'git']) chmodSync(join(dir, name), 0o755);
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const env = { ...process.env };
    const pathName = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    const sep = process.platform === 'win32' ? ';' : ':';
    env[pathName] = `${dir}${sep}${env[pathName] ?? ''}`;
    Object.assign(env, {
      GITHUB_OUTPUT: output,
      REPO: 'ashlrai/phantom',
      SHA: 'a'.repeat(40),
      VERSION_FILE: 'package.json',
      NEW_VERSION: newVersion,
      OLD_VERSION: oldVersion,
      SUBJECT: subject,
    });
    const result = spawnSync('bash', ['-c', versionStep.run!], { encoding: 'utf8', env });
    return {
      status: result.status ?? 1,
      output: readFileSync(output, 'utf8'),
      log: (result.stdout ?? '') + (result.stderr ?? ''),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runShaValidation(sha: string, status: string) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tag-sha-'));
  try {
    const calls = join(dir, 'gh-calls');
    writeFileSync(calls, '');
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_CALLS"
printf '%s\\n' "$GH_STATUS"
`);
    chmodSync(join(dir, 'gh'), 0o755);
    const result = spawnSync('bash', ['-c', validateShaStep.run!], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, CANDIDATE_SHA: sha,
        REPO: 'ashlrai/phantom', GH_TOKEN: 'stub', GH_CALLS: calls, GH_STATUS: status,
      },
    });
    return { status: result.status, log: result.stdout + result.stderr, calls: readFileSync(calls, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ok = (name: string): Run => ({ name, conclusion: 'success' });
const allGreen = [ok('Merge Gate'), ok(GEN), ok(DRIFT)];

describe('Auto-tag version healing', () => {
  it('does not tag an unchanged version from a non-release commit', () => {
    const result = runVersionStep('3.30.74', '3.30.74', 'bridge(RQ-DVL): (#8762)');
    expect(result.status, result.log).toBe(0);
    expect(result.output).toContain('changed=false');
    expect(result.output).not.toContain('changed=true');
    expect(result.log).toContain('::notice::v3.30.74 is owed by its release-please commit; not tagging non-release commit');
  });

  it('preserves unchanged-version healing for release-please commits', () => {
    const result = runVersionStep('3.30.74', '3.30.74', 'chore(phantom): release 3.30.74 (#8767)');
    expect(result.status, result.log).toBe(0);
    expect(result.output).toContain('version=3.30.74');
    expect(result.output).toContain('changed=true');
    expect(result.log).toContain('Version unchanged (3.30.74) but tag v3.30.74 is missing; tagging this commit.');
  });

  it('preserves version-bump behavior for release commits', () => {
    const result = runVersionStep('3.30.74', '3.30.73', 'chore(phantom): release 3.30.74');
    expect(result.status, result.log).toBe(0);
    expect(result.output).toContain('version=3.30.74');
    expect(result.output).toContain('changed=true');
    expect(result.log).toContain('Version bumped 3.30.73 -> 3.30.74; tagging this commit.');
  });
});

describe('Auto-tag requires both split checks on the exact sha', { timeout: 60_000 }, () => {
  it('validates an explicit dispatch SHA before minting write authority', () => {
    const steps = workflow.jobs.tag.steps;
    const mint = steps.findIndex((entry) => entry.id === 'app');
    const validation = steps.indexOf(validateShaStep);
    expect(validation).toBe(0);
    expect(validation).toBeLessThan(mint);
    expect(validateShaStep.if).toBe("github.event_name == 'workflow_dispatch' && inputs.sha != ''");

    const invalid = runShaValidation('not-a-commit', 'identical');
    expect(invalid.status).not.toBe(0);
    expect(invalid.calls).toBe('');
    for (const status of ['ahead', 'identical']) {
      const valid = runShaValidation('a'.repeat(40), status);
      expect(valid.status, valid.log).toBe(0);
      expect(valid.calls).toContain('repos/ashlrai/phantom/compare/');
      expect(valid.calls).toContain('...master');
    }
    const diverged = runShaValidation('b'.repeat(40), 'diverged');
    expect(diverged.status).not.toBe(0);
    expect(diverged.calls).toContain('...master');
  });

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
    expect(workflow.jobs.tag.if).toContain("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master'");
    const trigger = workflow.jobs.tag.env.TRIGGER.replace(/^\$\{\{|\}\}$/g, '')
      .replaceAll('github.event_name', 'event').replaceAll('github.event.workflow_run.event', 'source');
    expect(runInNewContext(trigger, { event: 'workflow_dispatch', source: undefined })).toBe('workflow_dispatch');
    const dispatch = workflow.on.workflow_dispatch as { inputs?: Record<string, unknown> };
    expect(dispatch.inputs?.sha).toEqual({
      description: 'Exact release-gated master commit to evaluate', required: false, type: 'string', default: '',
    });
    expect(workflow.jobs.tag.env.SHA).toContain("github.event_name == 'workflow_dispatch' && inputs.sha != '' && inputs.sha");
    expect(workflow.concurrency.group).toContain("github.event_name == 'workflow_dispatch' && inputs.sha != '' && inputs.sha");
    expect(workflow.jobs.tag.env.TRIGGER).toContain("|| github.event_name");
  });
});
