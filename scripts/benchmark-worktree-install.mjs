#!/usr/bin/env node
/** Isolated install snapshots; never removes an existing checkout's modules. */
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { PNPM_VERSION } from './worktree-install.mjs';

const exec = promisify(execFile);
const root = resolve(process.argv[2] ?? '.');
const output = resolve(process.argv[3] ?? 'worktree-install-benchmark.json');
const parent = await mkdtemp(join(root, '.install-benchmark-'));
const store = join(parent, 'store');
const cache = join(parent, 'npm-cache');
const files = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
async function bytes(path) {
  const { stdout } = await exec('du', ['-sk', path]);
  return Number(stdout.trim().split(/\s+/)[0]) * 1024;
}
try {
  if ((await exec('pnpm', ['--version'])).stdout.trim() !== PNPM_VERSION) throw new Error('Wrong pnpm version');
  await mkdir(store);
  if ((await stat(root)).dev !== (await stat(store)).dev) throw new Error('Cross-device benchmark');
  const rows = [];
  let sharedTarget;
  for (const kind of ['npm', 'npm-warm', 'pnpm-cold', 'pnpm-warm']) {
    const cwd = join(parent, kind);
    await mkdir(cwd);
    for (const file of files) await copyFile(join(root, file), join(cwd, file));
    const started = performance.now();
    const args = kind.startsWith('npm')
      ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache]
      : ['install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', store];
    await exec(kind.startsWith('npm') ? 'npm' : 'pnpm', args, {
      cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CI: 'false' },
    });
    const durationMs = Math.round(performance.now() - started);
    if (!kind.startsWith('npm')) {
      const target = await realpath(join(cwd, 'node_modules/vitest'));
      if (!target.startsWith(`${store}/`)) throw new Error('Global virtual store was not used');
      if (sharedTarget && sharedTarget !== target) throw new Error('Worktrees did not share the dependency graph');
      sharedTarget = target;
    }
    rows.push({ kind, durationMs, nodeModulesAllocatedBytes: await bytes(join(cwd, 'node_modules')), sharedStoreAllocatedBytes: await bytes(store) });
    console.log(JSON.stringify(rows.at(-1)));
  }
  const report = { measuredAt: new Date().toISOString(), platform: process.platform, node: process.version, pnpm: PNPM_VERSION,
    methodology: 'Manifest snapshots on checkout volume; empty npm cache for first npm install, reused for npm-warm; empty shared store for cold pnpm, reused for pnpm-warm. Verified identical vitest realpaths across pnpm snapshots. Lifecycle scripts disabled equally. du -sk does not follow dependency symlinks and counts APFS shared extents repeatedly. Store cost reported separately.', rows };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
} catch {
  // Registry errors can contain authentication data; keep child output private.
  console.error('Install benchmark failed; verify tool versions, lockfiles and registry access');
  process.exitCode = 1;
} finally {
  await rm(parent, { recursive: true, force: true });
}
