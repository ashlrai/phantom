// Security floor (RQ-PHANTOM-SECRET-SCAN-CI): the diff secret scan runs on
// every PR, merge_group and master push, on Linux only, from a pinned and
// checksum-verified Gitleaks, ignores repo-supplied config and gates merges.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '..');
const workflow = parse(readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as {
  on: Record<string, unknown>; jobs: Record<string, Record<string, unknown>>;
};
const job = workflow.jobs['secret-scan']!;
const steps = job.steps as { name: string; run?: string; env?: Record<string, string> }[];
const install = steps.find((step) => step.name === 'Install pinned Gitleaks')!;
const scan = steps.find((step) => step.name === 'Scan the commits this event adds')!;
// Live run: point PHANTOM_GITLEAKS_BIN at the pinned 8.30.0 linux_x64 binary.
const gitleaks = process.env.PHANTOM_GITLEAKS_BIN;

describe('secret-scan CI job', () => {
  it('runs unconditionally on Ubuntu for PR, merge_group and master push', () => {
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(['pull_request', 'merge_group', 'push']));
    expect((workflow.on['push'] as { branches: string[] }).branches).toEqual(['master']);
    for (const event of ['push', 'pull_request', 'merge_group']) {
      const trigger = (workflow.on[event] ?? {}) as Record<string, unknown>;
      expect(trigger['paths']).toBeUndefined(); expect(trigger['paths-ignore']).toBeUndefined();
    }
    expect(job.name).toBe('Secret scan (diff)');
    expect(job['runs-on']).toBe('ubuntu-latest');
    for (const key of ['if', 'needs', 'strategy', 'continue-on-error']) expect(job[key], key).toBeUndefined();
    expect(steps.every((step) => !('if' in step) && !('continue-on-error' in step))).toBe(true);
  });

  it('installs an exact Gitleaks release verified against a pinned SHA-256', () => {
    expect(install.env).toEqual({ GITLEAKS_VERSION: '8.30.0',
      GITLEAKS_SHA256: '79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e' });
    expect(install.run).toContain('sha256sum --check --strict');
    expect(install.run!.indexOf('sha256sum')).toBeLessThan(install.run!.indexOf('tar -xzf'));
  });

  it('removes repo-supplied config before a redacted scan', () => {
    const run = scan.run!;
    expect(run).toContain('rm -f .gitleaks.toml .gitleaksignore');
    expect(run.indexOf('rm -f .gitleaks.toml')).toBeLessThan(run.indexOf('gitleaks" git'));
    expect(run).toContain('--redact');
    expect(run).toMatch(/^set -euo pipefail/);
  });

  it('is a Merge Gate dependency that must succeed', () => {
    const gate = workflow.jobs['merge-gate']!;
    expect(gate.needs).toContain('secret-scan');
    const source = String((gate.steps as { run: string }[])[0]!.run);
    expect(source).toContain("if (outcome('secret-scan') !== 'success')");
    const deferred = source.match(/const deferred[\s\S]*?: \[\];/)?.[0];
    expect(deferred).toBeTruthy();
    expect(deferred).not.toContain('secret-scan');
    expect(source.match(/const superseded[\s\S]*?: \[\];/)?.[0]).not.toContain('secret-scan');
  });

  it.runIf(gitleaks && existsSync(gitleaks))('fails on a committed fake secret even when the repo allowlists it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phantom-secret-scan-'));
    try {
      const work = join(dir, 'repo'); const runner = join(dir, 'runner');
      mkdirSync(join(runner, 'gitleaks-bin'), { recursive: true });
      symlinkSync(gitleaks!, join(runner, 'gitleaks-bin', 'gitleaks'));
      mkdirSync(work);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'master'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
      writeFileSync(join(work, 'README.md'), 'clean\n'); git('add', '.'); git('commit', '-qm', 'root');
      const root = git('rev-parse', 'HEAD');
      writeFileSync(join(work, 'notes.md'), 'still clean\n'); git('add', '.'); git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      // The PR tries to allowlist its own leak; the job must delete this first.
      writeFileSync(join(work, '.gitleaks.toml'), '[allowlist]\npaths = [\'\'\'.*\'\'\']\n');
      writeFileSync(join(work, '.gitleaksignore'), '*\n');
      const key = ['AKIA', 'QYLPMN5HHHFPZAM2'].join('');
      writeFileSync(join(work, 'config.env'), `AWS_ACCESS_KEY_ID=${key}\n`);
      git('add', '.'); git('commit', '-qm', 'leak');
      const head = git('rev-parse', 'HEAD');
      const runScan = () => spawnSync('bash', ['-c', scan.run!], { cwd: work, encoding: 'utf8', env: { ...process.env,
        RUNNER_TEMP: runner, EVENT_NAME: 'pull_request', PR_BASE: base, MG_BASE: '', PUSH_BEFORE: '', HEAD_SHA: head } });
      const leaked = runScan();
      expect(leaked.status, leaked.stdout + leaked.stderr).not.toBe(0);
      expect(leaked.stdout + leaked.stderr).toMatch(/leaks found: [1-9]/);
      expect(leaked.stdout + leaked.stderr).not.toContain(key);
      expect(existsSync(join(work, '.gitleaks.toml'))).toBe(false);
      git('checkout', '-q', base);
      const clean = spawnSync('bash', ['-c', scan.run!], { cwd: work, encoding: 'utf8', env: { ...process.env,
        RUNNER_TEMP: runner, EVENT_NAME: 'push', PR_BASE: '', MG_BASE: '', PUSH_BEFORE: root, HEAD_SHA: base } });
      expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
