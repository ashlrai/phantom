#!/usr/bin/env node
/** Frozen installs for trusted sibling worktrees, with a same-volume store. */
import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

const exec = promisify(execFile);
export const PNPM_VERSION = '10.28.2';

export async function storeForWorktree(root, io = {}) {
  const run = io.exec ?? exec;
  const inspect = io.stat ?? stat;
  const create = io.mkdir ?? mkdir;
  const { stdout } = await run('git', ['rev-parse', '--git-common-dir'], { cwd: root });
  const common = stdout.trim();
  if (!common) throw new Error('Git common directory is missing');
  const store = join(isAbsolute(common) ? common : resolve(root, common), 'phantom-pnpm-store');
  await create(store, { recursive: true, mode: 0o700 });
  const [checkout, cache] = await Promise.all([inspect(root), inspect(store)]);
  if (checkout.dev !== cache.dev) throw new Error('Shared store must be on the worktree volume');
  return store;
}

export async function installWorktree(root, io = {}) {
  const run = io.exec ?? exec;
  root = await (io.realpath ?? realpath)(root);
  // pnpm 10 disables the global virtual store in CI. Refuse rather than
  // silently claiming a shared installation while making a full local tree.
  if ((io.env ?? process.env).CI && (io.env ?? process.env).CI !== 'false') throw new Error('Use npm ci in CI; this installer is for trusted local worktrees');
  const version = await run('pnpm', ['--version'], { cwd: root });
  if (version.stdout.trim() !== PNPM_VERSION) throw new Error(`Install pnpm ${PNPM_VERSION} before preparing worktree dependencies`);
  const store = await storeForWorktree(root, { ...io, exec: run });
  const started = performance.now();
  await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--config.enable-global-virtual-store=true', '--store-dir', store], {
    cwd: root, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  });
  return { packageManager: `pnpm@${PNPM_VERSION}`, store, durationMs: Math.round(performance.now() - started) };
}

/** Donor checkout for healing: PHANTOM_WT_DONOR, else the default sibling when present. */
export async function healDonor(io = {}) {
  const env = io.env ?? process.env;
  const donor = env.PHANTOM_WT_DONOR || join(io.home ?? homedir(), 'Projects/ashlrai/wt/guardian-phantom');
  try { await (io.stat ?? stat)(donor); return donor; } catch { return null; }
}

/** Best-effort: run wt-deps, then tsc-warm. A failing step logs one line and never throws. */
export async function healWorktree(root, io = {}) {
  const run = io.exec ?? exec;
  const log = io.log ?? console.error;
  const donor = await healDonor(io);
  if (!donor) return { donor: null, steps: [] };
  const steps = [];
  for (const verb of ['wt-deps', 'tsc-warm']) {
    try {
      await run('pnpm', ['exec', 'tsx', 'src/cli/index.ts', 'fleet', verb, '--dir', root, '--from', donor, '--apply'], { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      steps.push({ verb, ok: true });
    } catch {
      // Child output is never forwarded; one fixed line per failed step.
      log(`Worktree heal step ${verb} failed; continuing (run \`ashlr fleet ${verb} --from <donor> --apply\` by hand)`);
      steps.push({ verb, ok: false });
    }
  }
  return { donor, steps };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/worktree-install.mjs [WORKTREE]');
    const root = resolve(process.argv[2] ?? '.');
    const result = await installWorktree(root);
    const heal = await healWorktree(root);
    console.log(JSON.stringify({ ...result, heal: heal.steps }));
  } catch (error) {
    // Child output may include registry credentials; never forward it.
    console.error(error.cmd ? 'Worktree install failed (child process); check tool availability and lockfile consistency' : error.message);
    process.exitCode = 1;
  }
}
