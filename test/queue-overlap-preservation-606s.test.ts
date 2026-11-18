import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('dispatches the preserved verb with local evidence, unknowns and stable exit statuses', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'queue-overlap-606s-')); dirs.push(cwd);
  const runs = join(cwd, 'runs');
  for (const dir of ['src', 'home', 'runs/fleet', 'runs/queue']) mkdirSync(join(cwd, dir), { recursive: true });
  vi.stubEnv('HOME', join(cwd, 'home')); vi.stubEnv('ASHLR_RUNS_DIR', runs);
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q'); git('remote', 'add', 'origin', 'https://github.com/fixture/queue-demo.git');
  writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1;');
  git('add', 'src/a.ts');
  const commit = git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', git('write-tree'), '-m', 'Fixture');
  git('update-ref', 'refs/remotes/origin/trunk', commit);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  const prompt = join(cwd, 'RQ-SELF.md'), snapshot = join(runs, 'fleet/open-prs.json'), queue = join(runs, 'queue/router-queue.md');
  writeFileSync(prompt, 'Edit src/a.ts and src/b.ts\nDo not edit src/ignored.ts');
  writeFileSync(snapshot, JSON.stringify({ repo: 'fixture/queue-demo', items: [{ number: 11, files: ['src/b.ts'] }] }));
  writeFileSync(queue, '- CLAIMED now worker RQ-OTHER (repo=fixture/queue-demo): src/a.ts\n- READY RQ-SELF (repo=fixture/queue-demo): src/b.ts\n- READY RQ-FOREIGN (repo=other/queue-demo): src/a.ts\n- DONE RQ-DONE (repo=fixture/queue-demo): src/b.ts');
  const evidence = [prompt, snapshot, queue, join(cwd, '.git/refs/remotes/origin/HEAD'), join(cwd, '.git/refs/remotes/origin/trunk')];
  const before = evidence.map(path => readFileSync(path, 'utf8'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const run = (...args: string[]) => cmdFleet(['queue-overlap', ...args], FLEET_SUBCOMMAND_LOADERS);
  expect(await run(prompt, '--json')).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({
    schema: 'queue.overlap.v1', defaultCommit: commit, paths: ['src/a.ts', 'src/b.ts'],
    defaultBranchPaths: ['src/a.ts'], openPrs: [{ number: 11, paths: ['src/b.ts'] }],
    queued: [{ id: 'RQ-OTHER', paths: ['src/a.ts'] }],
  });
  expect(evidence.map(path => readFileSync(path, 'utf8'))).toEqual(before);
  rmSync(snapshot); rmSync(queue); git('update-ref', '-d', 'refs/remotes/origin/trunk');
  expect(await run(prompt, '--json')).toBe(0);
  const unknown = JSON.parse(log.mock.calls.at(-1)![0] as string);
  expect(unknown).toMatchObject({ schema: 'queue.overlap.v1', defaultCommit: null, defaultBranchPaths: null, openPrs: null, queued: null });
  expect(unknown.gaps).toHaveLength(4);
  expect(readFileSync(prompt, 'utf8')).toBe(before[0]);
  expect(await run(join(cwd, 'missing.md'), '--json')).toBe(1);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({ schema: 'queue.overlap.v1', error: 'Cannot read prompt; use a regular file of at most 4 MiB.' });
  for (const args of [[], ['--apply'], [prompt, '--wat'], [prompt, '--json', '--json']]) expect(await run(...args)).toBe(2);
});
