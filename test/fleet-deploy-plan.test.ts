import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildFleetDeployPlan } from '../src/core/fleet/deploy-plan.js';
import { cmdFleetDeployPlan } from '../src/cli/fleet-deploy-plan.js';

const roots: string[] = [];
afterEach(() => { roots.forEach(root => rmSync(root, { recursive: true, force: true })); roots.length = 0; vi.restoreAllMocks(); });
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'deploy-plan-')); roots.push(repo);
  const bin = join(repo, 'live');
  for (const dir of ['fleet', 'contrib/mac', 'live']) mkdirSync(join(repo, dir), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  writeFileSync(join(repo, 'fleet/manifest.json'), JSON.stringify({ schema: 'fleet.machinery.v1', files: ['same', 'drift', 'pinned', 'missing'].map(name => ({ src: `contrib/mac/${name}.py`, root: 'runs-bin', class: name === 'pinned' ? 'pinned' : 'managed' })) }));
  writeFileSync(join(repo, 'contrib/mac/install.sh'), 'FILES="installer.py"\n');
  git('add', '.'); git('commit', '-qm', 'base'); const since = git('rev-parse', 'HEAD');
  for (const name of ['same', 'drift', 'pinned', 'missing', 'installer', 'unknown']) writeFileSync(join(repo, `contrib/mac/${name}.py`), 'new\n');
  git('add', 'contrib'); git('commit', '-qm', 'merged scripts');
  for (const name of ['same', 'drift', 'pinned']) writeFileSync(join(bin, `${name}.py`), name === 'same' ? 'new\n' : 'old\n');
  return { repo, bin, since };
}
it('compares committed scripts, omits in-sync copies and marks pins for Security review without writing', async () => {
  const { repo, bin, since } = fixture();
  writeFileSync(join(repo, 'contrib/mac/same.py'), 'dirty local edit');
  const plan = await buildFleetDeployPlan(repo, bin, since);
  expect(plan).toMatchObject({ checked: 6, inSync: 1 });
  expect(plan.files.map(file => [file.repoPath.split('/').pop(), file.status, file.shaPinned, file.action])).toEqual([
    ['drift.py', 'drifted', false, 'review'], ['installer.py', 'missing', true, 'security-review'],
    ['missing.py', 'missing', false, 'review'], ['pinned.py', 'drifted', true, 'security-review'], ['unknown.py', 'missing', null, 'security-review'],
  ]);
  expect(plan.files[0]).toMatchObject({ livePath: join(bin, 'drift.py'), repoSha256: expect.stringMatching(/^[a-f0-9]{64}$/), liveSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await buildFleetDeployPlan(repo, bin, since)).toEqual(plan);
  expect((await buildFleetDeployPlan(repo, bin, plan.head)).files).toEqual([]);
});
it('refuses symlinks and invalid arguments and exposes typed JSON through the CLI', async () => {
  const { repo, bin, since } = fixture();
  symlinkSync(join(bin, 'same.py'), join(bin, 'missing.py'));
  expect((await buildFleetDeployPlan(repo, bin, since)).files.find(file => file.repoPath.endsWith('missing.py'))?.status).toBe('unreadable');
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdFleetDeployPlan(['--since', since, '--repo', repo, '--bin', bin, '--json'])).toBe(1);
  expect(JSON.parse(output.mock.calls[0]![0]).schema).toBe('fleet.deploy-plan.v1');
  expect(await cmdFleetDeployPlan(['--apply'])).toBe(2);
  expect(await cmdFleetDeployPlan(['--since', '--json'])).toBe(2);
  expect(await cmdFleetDeployPlan(['--since', 'bad'])).toBe(2);
  await expect(buildFleetDeployPlan(repo, bin, '--all')).rejects.toThrow('commit SHA');
});
