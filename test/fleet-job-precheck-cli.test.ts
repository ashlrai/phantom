import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobPrecheck } from '../src/cli/fleet-job-precheck.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-precheck-'));
  dirs.push(dir);
  return dir;
}

const landed = {
  async exists(path: string) { return path === 'src/done.ts'; },
  async lastCommit(path: string) {
    return path === 'src/done.ts' ? { sha: 'abc1234', subject: 'bridge(RQ-PHX-DONE1): landed' } : null;
  },
};

it('prints json and exits 3 when the fake adapter says the src work already landed', async () => {
  const dir = tempDir();
  const file = join(dir, 'job.md');
  writeFileSync(file, 'src/done.ts\ntest/more.test.ts\nDo not edit src/cli/fleet.ts\n');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetJobPrecheck([file, '--ref', 'origin/master', '--json'], { git: landed });
  expect(code).toBe(3);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
    schema: 'fleet.job-precheck.v1',
    verdict: 'likely-done',
    newTestFiles: ['test/more.test.ts'],
    facts: [
      { path: 'src/done.ts', onMaster: true, lastCommit: { sha: 'abc1234', subject: 'bridge(RQ-PHX-DONE1): landed' } },
      { path: 'test/more.test.ts', onMaster: false },
    ],
  });
});

it('uses git cat-file and log in a temp repo and exits 3 for a bridge commit', async () => {
  const dir = tempDir();
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Precheck',
    GIT_AUTHOR_EMAIL: 'precheck@example.com',
    GIT_COMMITTER_NAME: 'Precheck',
    GIT_COMMITTER_EMAIL: 'precheck@example.com',
  };
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  git(['init']);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'done.ts'), 'export const done = true;\n');
  git(['add', 'src/done.ts']);
  git(['-c', 'user.name=Precheck', '-c', 'user.email=precheck@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'bridge(RQ-PHX-DONE1): landed']);
  const file = join(dir, 'job.md');
  writeFileSync(file, 'Edit src/done.ts and add test/more.test.ts\n');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetJobPrecheck([file, '--json', '--ref', 'HEAD'], { cwd: dir });
  expect(code).toBe(3);
  const body = JSON.parse(String(log.mock.calls[0]![0])) as { verdict: string; newTestFiles: string[]; facts: { onMaster: boolean; lastCommit?: { subject: string } }[] };
  expect(body.verdict).toBe('likely-done');
  expect(body.facts[0]!.onMaster).toBe(true);
  expect(body.facts[0]!.lastCommit?.subject).toContain('bridge(RQ-PHX-DONE1)');
  expect(body.newTestFiles).toEqual(['test/more.test.ts']);
  const missing = await cmdFleetJobPrecheck([file, '--json', '--ref', 'no-such-ref'], { cwd: dir });
  expect(missing).toBe(2);
});

it('prints one line per path and exits 0 for a fresh draft', async () => {
  const dir = tempDir();
  const file = join(dir, 'job.md');
  writeFileSync(file, 'src/new.ts test/new.test.ts\n');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetJobPrecheck([file], {
    git: { async exists() { return false; }, async lastCommit() { return null; } },
  });
  expect(code).toBe(0);
  expect(log.mock.calls.map(call => call[0])).toEqual([
    'src/new.ts missing',
    'test/new.test.ts missing',
    'verdict: fresh',
  ]);
});

it('registers the verb and refuses bad args without reading a file', async () => {
  expect((await FLEET_SUBCOMMAND_LOADERS['job-precheck']!()).cmdFleetJobPrecheck).toBe(cmdFleetJobPrecheck);
  const readFile = vi.fn(async () => 'src/new.ts');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetJobPrecheck(['--help'], { readFile })).toBe(0);
  expect(await cmdFleetJobPrecheck(['-h'], { readFile })).toBe(0);
  expect(String(log.mock.calls[0]![0])).toContain('Usage: ashlr fleet job-precheck');
  for (const args of [[], ['--json'], ['job.md', '--ref'], ['job.md', '--ref', '--upload-pack'], ['--nope', 'job.md']]) {
    expect(await cmdFleetJobPrecheck(args, { readFile })).toBe(2);
  }
  expect(readFile).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
});
