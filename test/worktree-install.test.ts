import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { installWorktree, storeForWorktree } from '../scripts/worktree-install.mjs';

describe('shared worktree install store', () => {
  function fixture(common: string, device = 7) {
    return {
      exec: vi.fn(async () => ({ stdout: `${common}\n` })),
      mkdir: vi.fn(async () => undefined),
      stat: vi.fn(async (path: string) => ({ dev: path.endsWith('phantom-pnpm-store') ? device : 7 })),
    };
  }
  it('shares the common git directory across sibling worktrees', async () => {
    const io = fixture('/repo/.git');
    const first = await storeForWorktree('/worktrees/one', io);
    const second = await storeForWorktree('/worktrees/two', io);
    expect(first).toBe('/repo/.git/phantom-pnpm-store');
    expect(second).toBe(first);
    expect(io.mkdir).toHaveBeenCalledWith(first, { recursive: true, mode: 0o700 });
    expect(io.exec).toHaveBeenCalledWith('git', ['rev-parse', '--git-common-dir'], { cwd: '/worktrees/two' });
  });
  it('resolves relative git common directories against the checkout', async () => {
    expect(await storeForWorktree('/repo', fixture('.git'))).toBe('/repo/.git/phantom-pnpm-store');
  });
  it('refuses a store on another device instead of falling back to copies', async () => {
    await expect(storeForWorktree('/repo', fixture('/other/.git', 8))).rejects.toThrow('worktree volume');
  });
  it('refuses missing git output and propagates filesystem failures', async () => {
    await expect(storeForWorktree('/repo', fixture(''))).rejects.toThrow('missing');
    const io = fixture('.git');
    io.mkdir.mockRejectedValueOnce(new Error('permission denied'));
    await expect(storeForWorktree('/repo', io)).rejects.toThrow('permission denied');
  });
});


describe('frozen shared installer', () => {
  const root = '/worktrees/one';
  function fixture(version = '10.28.2') {
    return {
      env: {},
      realpath: vi.fn(async (path: string) => path),
      stat: vi.fn(async () => ({ dev: 7 })),
      mkdir: vi.fn(async () => undefined),
      exec: vi.fn(async (_bin: string, args: string[]) => ({ stdout: args[0] === '--version' ? version : '/repo/.git' })),
    };
  }
  it('pins the tool, freezes resolution and disables lifecycle scripts', async () => {
    const io = fixture();
    const result = await installWorktree(root, io);
    expect(result.store).toBe('/repo/.git/phantom-pnpm-store');
    expect(io.exec).toHaveBeenLastCalledWith('pnpm', [
      'install', '--frozen-lockfile', '--ignore-scripts', '--config.enable-global-virtual-store=true',
      '--store-dir', result.store,
    ], expect.objectContaining({ cwd: root, timeout: 180_000 }));
  });
  it('refuses unsupported versions before creating the store', async () => {
    const io = fixture('12.0.0');
    await expect(installWorktree(root, io)).rejects.toThrow('10.28.2');
    expect(io.mkdir).not.toHaveBeenCalled();
  });
  it('refuses CI rather than silently duplicating the virtual store', async () => {
    const io = { ...fixture(), env: { CI: 'true' } };
    await expect(installWorktree(root, io)).rejects.toThrow('CI');
    expect(io.exec).not.toHaveBeenCalled();
  });
});


describe('shared install dependency contract', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  it('keeps security overrides identical for npm and pnpm', () => {
    const manifest = JSON.parse(read('../package.json'));
    const workspace = parse(read('../pnpm-workspace.yaml'));
    expect(workspace.overrides).toEqual(manifest.overrides);
    expect(workspace.enableGlobalVirtualStore).toBe(true);
    expect([...manifest.bundledDependencies].sort()).toEqual(Object.keys(manifest.dependencies).sort());
    expect(manifest.bundleDependencies).toEqual(manifest.bundledDependencies);
  });
  it('keeps frozen importer specifiers aligned with the package manifest', () => {
    const manifest = JSON.parse(read('../package.json'));
    const lock = parse(read('../pnpm-lock.yaml')).importers['.'];
    for (const kind of ['dependencies', 'devDependencies']) {
      expect(Object.fromEntries(Object.entries(lock[kind]).map(([name, entry]) =>
        [name, (entry as { specifier: string }).specifier]))).toEqual(manifest[kind]);
    }
  });
});
