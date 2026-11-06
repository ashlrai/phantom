import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobPrecheck, resolveJobPrecheckRef } from '../src/cli/fleet-job-precheck.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'precheck-snapshot-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  } }).trim();
  git('init', '-q');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'one.ts'), 'one');
  writeFileSync(join(dir, 'src', 'two.ts'), 'two');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'bridge(RQ-OLD): old');
  const old = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.md'), 'src/one.ts');
  writeFileSync(join(dir, 'b.md'), 'src/two.ts');
  return { dir, git, old };
}

it.each([false, true])('pins all real probes to the resolved commit (batch=%s)', async batch => {
  const { dir, git, old } = repo();
  const out: string[] = [];
  const resolveRef = async (ref: string, cwd?: string) => {
    const oid = await resolveJobPrecheckRef(ref, cwd);
    git('rm', '-q', 'src/one.ts', 'src/two.ts');
    git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'remove files');
    return oid;
  };
  const args = batch ? ['--batch', join(dir, 'a.md'), join(dir, 'b.md')] : [join(dir, 'a.md')];
  const code = await cmdFleetJobPrecheck([...args, '--ref', 'HEAD', '--json'], { cwd: dir, resolveRef, log: line => out.push(line) });
  expect(code).toBe(3);
  const body = JSON.parse(out[0]!);
  expect(body).toMatchObject({ ref: 'HEAD', resolvedRef: old });
  const reports = batch ? body.results : [body];
  expect(reports).toHaveLength(batch ? 2 : 1);
  for (const report of reports) expect(report.facts[0]).toMatchObject({ onMaster: true, lastCommit: { subject: 'bridge(RQ-OLD): old' } });
});

it('rejects invalid and missing refs before probing or reporting success', async () => {
  const { dir } = repo();
  const exists = vi.fn(async () => false);
  const out: string[] = [];
  const error = vi.fn();
  const git = { exists, lastCommit: vi.fn(async () => null) };
  expect(await cmdFleetJobPrecheck(['a.md', '--ref', '-bad'], { cwd: dir, git, log: line => out.push(line), error })).toBe(2);
  expect(await cmdFleetJobPrecheck(['--batch', 'a.md', '--ref', 'missing', '--json'], {
    cwd: dir, git, resolveRef: resolveJobPrecheckRef, log: line => out.push(line), error,
  })).toBe(2);
  expect(exists).not.toHaveBeenCalled();
  expect(out).toEqual([]);
});

it('keeps injected probes independent of real git and discloses unavailable metadata', async () => {
  const out: string[] = [];
  const code = await cmdFleetJobPrecheck(['draft', '--json'], {
    cwd: '/nonexistent', readFile: async () => 'src/new.ts',
    git: { exists: async () => false, lastCommit: async () => null }, log: line => out.push(line),
  });
  expect(code).toBe(0);
  expect(JSON.parse(out[0]!)).toMatchObject({ ref: 'origin/master', resolvedRef: null, verdict: 'fresh' });
});
