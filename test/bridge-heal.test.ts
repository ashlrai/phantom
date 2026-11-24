import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDependencies } from '../scripts/bridge-worktree.mjs';
import { healPaths } from '../scripts/bridge-heal.mjs';

const roots: string[] = [];
const manifest = '{"name":"heal-fixture","version":"1.0.0"}\n';
const lockfile = '{"name":"heal-fixture","lockfileVersion":3,"packages":{}}\n';
const plenty = async () => 21 * 1024 ** 3;
const copyTree = async (from: string, to: string) => cp(from, to, { recursive: true });

/** Writes the tool files a healthy install has: a tsgo bin and an eslint that starts. */
async function installTools(source: string) {
  const modules = join(source, 'node_modules');
  await mkdir(join(modules, '.bin'), { recursive: true });
  await mkdir(join(modules, 'eslint', 'lib'), { recursive: true });
  await mkdir(join(modules, 'eslint', 'bin'), { recursive: true });
  await writeFile(join(modules, '.bin', 'tsgo'), '#!/bin/sh\nexit 0\n');
  await chmod(join(modules, '.bin', 'tsgo'), 0o755);
  await writeFile(join(modules, 'eslint', 'lib', 'cli.js'), '');
  await writeFile(join(modules, 'eslint', 'bin', 'eslint.js'), 'process.exit(0);\n');
}

async function fixture({ healthy }: { healthy: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'phantom-bridge-heal-'));
  roots.push(root);
  const source = join(root, 'source');
  const target = join(root, 'target');
  await mkdir(join(source, 'node_modules', 'plain'), { recursive: true });
  await mkdir(target);
  for (const dir of [source, target]) {
    await writeFile(join(dir, 'package.json'), manifest);
    await writeFile(join(dir, 'package-lock.json'), lockfile);
  }
  if (healthy) await installTools(source);
  return { source, target };
}

const run = (source: string, target: string, heal: Record<string, unknown>, say = vi.fn()) =>
  prepareDependencies({ source, target, heal: true }, { platform: 'darwin', freeBytes: plenty, clone: copyTree, heal, say });

const logLines = async (source: string) =>
  (await readFile(healPaths(source).log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bridge source self-heal', () => {
  it('clones a healthy source without running the repair', async () => {
    const { source, target } = await fixture({ healthy: true });
    const npm = vi.fn(async () => true);
    const say = vi.fn();
    const result = await run(source, target, { npm }, say);
    expect(npm).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
    expect(result).toMatchObject({ method: 'apfs-clone', heal: 'none' });
    expect(existsSync(join(target, 'node_modules', '.bin', 'tsgo'))).toBe(true);
    expect(await logLines(source)).toMatchObject([{ schema: 'phm.bridge.source-heal/1', event: 'probe', ok: true }]);
  });

  it('repairs a broken source once, then clones the repaired tree', async () => {
    const { source, target } = await fixture({ healthy: false });
    const npm = vi.fn(async (cwd: string) => { expect(cwd).toContain('source'); await installTools(source); return true; });
    const say = vi.fn();
    const result = await run(source, target, { npm }, say);
    expect(npm).toHaveBeenCalledOnce();
    expect(say).not.toHaveBeenCalled();
    expect(result).toMatchObject({ method: 'apfs-clone', heal: 'repaired' });
    expect(existsSync(join(target, 'node_modules', '.bin', 'tsgo'))).toBe(true);
    expect(await logLines(source)).toMatchObject([{ event: 'repaired', ok: true, tsgo: true, eslint: true }]);
    expect(existsSync(healPaths(source).lock)).toBe(false);
  });

  it('falls back to cloning with one plain line when the repair fails', async () => {
    const { source, target } = await fixture({ healthy: false });
    const say = vi.fn();
    const result = await run(source, target, { npm: async () => false }, say);
    expect(result).toMatchObject({ method: 'apfs-clone', heal: 'failed' });
    expect(say).toHaveBeenCalledOnce();
    expect(say.mock.calls[0]?.[0]).toMatch(/^Worktree has no lint\/typecheck:fast/);
    expect(existsSync(join(target, 'node_modules', 'plain'))).toBe(true);
    expect(await logLines(source)).toMatchObject([{ event: 'failed', ok: false, reason: 'repair command failed' }]);
    expect(existsSync(healPaths(source).lock)).toBe(false);
  });

  it('skips the repair when another process holds the lock, then falls back', async () => {
    const { source, target } = await fixture({ healthy: false });
    await mkdir(healPaths(source).lock);
    const npm = vi.fn(async () => true);
    const say = vi.fn();
    let clock = 0;
    const result = await run(source, target, { npm, lockWaitMs: 600_000, pollMs: 1, now: () => (clock += 300_000) }, say);
    expect(npm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ method: 'apfs-clone', heal: 'skipped' });
    expect(say).toHaveBeenCalledOnce();
    expect(existsSync(healPaths(source).lock)).toBe(true); // the other owner's lock is untouched
    expect(await logLines(source)).toMatchObject([{ event: 'skipped', reason: expect.stringContaining('lock') }]);
  });

  it('repairs at most once per hour', async () => {
    const { source, target } = await fixture({ healthy: false });
    const npm = vi.fn(async () => false);
    await run(source, target, { npm });
    await rm(join(target, 'node_modules'), { recursive: true });
    const say = vi.fn();
    const second = await run(source, target, { npm }, say);
    expect(npm).toHaveBeenCalledOnce();
    expect(second.heal).toBe('skipped');
    expect(say).toHaveBeenCalledOnce();

    // An hour later the repair may run again.
    const old = new Date(Date.now() - 61 * 60 * 1000);
    await utimes(healPaths(source).stamp, old, old);
    await rm(join(target, 'node_modules'), { recursive: true });
    const third = await run(source, target, { npm });
    expect(npm).toHaveBeenCalledTimes(2);
    expect(third.heal).toBe('failed');
  });

  it('does nothing unless heal is requested', async () => {
    const { source, target } = await fixture({ healthy: false });
    const result = await prepareDependencies({ source, target }, { platform: 'darwin', freeBytes: plenty, clone: copyTree });
    expect(result).not.toHaveProperty('heal');
    expect(existsSync(healPaths(source).log)).toBe(false);
  });
});
