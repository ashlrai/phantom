import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installBridge, findBridgeSource } from '../src/core/fleet/bridge-install.js';
import { cmdFleetBridgeInstall } from '../src/cli/fleet-bridge-install.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
let dir: string, root: string, source: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'bridge-test-'));
  root = join(dir, 'root'); source = join(dir, 'source');
  await fs.mkdir(root); await fs.mkdir(source);
  await fs.writeFile(join(source, 'a.py'), 'first');
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const run = (apply = true) => installBridge({ root, apply }, { source });
it('preview writes nothing and excludes tests, subfolders and symlinks', async () => {
  await fs.writeFile(join(source, 'test_a.py'), 'test');
  await fs.writeFile(join(source, 'a.ts'), 'test');
  await fs.mkdir(join(source, 'sub.py'));
  await fs.symlink(join(source, 'a.py'), join(source, 'link.py'));
  await fs.writeFile(join(source, 'with-memory.sh'), 'shell');
  const result = await run(false);
  expect(result.files.map(f => f.name)).toEqual(['a.py', 'with-memory.sh']);
  expect(await fs.readdir(root)).toEqual([]);
});
it('applies, verifies, reuses unchanged without writes, and publishes changed sources', async () => {
  const first = await run();
  const path = join(root, 'mac-bridge');
  const before = await fs.stat(join(path, 'current'));
  const second = await installBridge({ root, apply: true }, { source, fs: { ...fs, writeFile: async () => { throw new Error('write forbidden'); }, mkdtemp: async () => { throw new Error('temp forbidden'); } } });
  expect(second.unchanged).toBe(true);
  expect((await fs.stat(join(path, 'current'))).mtimeMs).toBe(before.mtimeMs);
  await fs.writeFile(join(source, 'a.py'), 'second');
  const third = await run();
  expect(third.releaseId).not.toBe(first.releaseId);
  expect(third.files[0].status).toBe('changed');
  expect(await fs.readlink(join(path, 'current'))).toBe(`releases/${third.releaseId}`);
  expect((await fs.stat(join(path, 'current/a.py'))).mode & 0o777).toBe(0o644);
});
it('refuses corrupted releases naming the file', async () => {
  await run();
  await fs.writeFile(join(root, 'mac-bridge/current/a.py'), 'corrupt');
  await expect(run()).rejects.toThrow('a.py');
});
it('failed copy preserves current and cleans temporary paths', async () => {
  await run();
  const current = join(root, 'mac-bridge/current');
  const old = await fs.readlink(current);
  await fs.writeFile(join(source, 'a.py'), 'changed');
  await expect(installBridge({ root, apply: true }, { source, fs: { ...fs, writeFile: async () => { throw new Error('copy failed'); } } })).rejects.toThrow('copy failed');
  expect(await fs.readlink(current)).toBe(old);
  expect((await fs.readdir(join(root, 'mac-bridge'))).sort()).toEqual(['current', 'releases']);
});
it.each(['mac-bridge', 'releases', 'current'])('refuses outside %s symlinks', async name => {
  const base = join(root, 'mac-bridge');
  if (name !== 'mac-bridge') await fs.mkdir(base);
  await fs.symlink(source, name === 'mac-bridge' ? base : join(base, name));
  await expect(run()).rejects.toThrow('Outside symlink');
});
it('retains three newest and an older current release; leaves unknown directories', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    await fs.writeFile(join(source, 'a.py'), String(i));
    const result = await installBridge({ root, apply: true }, { source, now: () => new Date(2030, 0, 4 - i) });
    ids.push(result.releaseId);
  }
  const releases = join(root, 'mac-bridge/releases');
  expect((await fs.readdir(releases)).sort()).toEqual(ids.sort());
  await fs.mkdir(join(releases, 'operator'));
  await fs.writeFile(join(source, 'a.py'), '5');
  await installBridge({ root, apply: true }, { source, now: () => new Date(2031, 0, 1) });
  expect(await fs.readdir(releases)).toContain('operator');
  expect((await fs.readdir(releases)).length).toBe(4);
});
it('installs real sibling imports for leader_failover help', async () => {
  const result = await installBridge({ root, apply: true }, { source: await findBridgeSource() });
  expect(result.files.length).toBeGreaterThan(10);
  const python = spawnSync('python3', [join(root, 'mac-bridge/current/leader_failover.py'), '--help'], { encoding: 'utf8' });
  expect(python.stdout).toContain('usage:');
  expect(python.status).toBe(0);
});
it('resolves the real registry verb', async () => {
  const resolved = resolveFleetSubcommand('bridge-install')!;
  expect((await FLEET_SUBCOMMAND_LOADERS['bridge-install']())[resolved.exportName]).toBe(cmdFleetBridgeInstall);
});
it('refuses missing root and source and returns argument errors', async () => {
  await expect(installBridge({ root: join(dir, 'missing') }, { source })).rejects.toThrow();
  expect(await cmdFleetBridgeInstall(['--unknown'])).toBe(2);
  expect(await cmdFleetBridgeInstall(['--root'])).toBe(2);
  expect(await cmdFleetBridgeInstall(['--root', root, '--json'], { source: join(dir, 'absent') })).toBe(1);
});
it('explains absent checkout assets clearly', async () => {
  await expect(findBridgeSource({ ...fs, stat: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } })).rejects.toThrow('needs a source checkout');
});
