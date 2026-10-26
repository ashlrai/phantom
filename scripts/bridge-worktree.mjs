#!/usr/bin/env node
/** Dependency preparation for trusted Mac bridge checkouts (not OS sandboxes). */
import { execFile } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, statfs, symlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const DISK_FLOOR_BYTES = 20 * 1024 ** 3;
const MANIFESTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', '.npmrc', '.pnpmfile.cjs'];

async function optionalFile(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function manifestsMatch(source, target) {
  let locked = false;
  for (const name of MANIFESTS) {
    const [a, b] = await Promise.all([optionalFile(join(source, name)), optionalFile(join(target, name))]);
    if (name === 'package.json' && (!a || !b)) throw new Error('Dependency manifest missing');
    if ((a === null) !== (b === null) || (a && !a.equals(b))) {
      throw new Error(`Dependency manifest differs: ${name}; install dependencies separately`);
    }
    if (a && /lock|shrinkwrap/.test(name)) locked = true;
  }
  if (!locked) throw new Error('A matching dependency lockfile is required');
}

async function freeBytes(path) {
  const fs = await statfs(path, { bigint: true });
  return fs.bavail * fs.bsize;
}

async function clone(source, destination, timeoutMs) {
  // cp -c may silently copy bytes; Node's FICLONE_FORCE returns ENOSYS on
  // macOS. The worker calls clonefile(2) directly for each leaf in the tree.
  // The system Python shim can stall in xcrun under an isolated HOME. Prefer
  // an installed interpreter at a fixed path; never resolve one from PATH.
  let python = '/usr/bin/python3';
  for (const candidate of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
    try { await access(candidate, constants.X_OK); python = candidate; break; }
    catch { /* Missing interpreters take the system shim, then link fallback. */ }
  }
  await exec(python, ['-I', fileURLToPath(new URL('./bridge-clone.py', import.meta.url)), source, destination], {
    timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  });
}

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

/**
 * Publish a complete dependency directory atomically. Distinct destinations
 * share no lock, subprocess queue or mutable cache. A duplicate destination
 * fails immediately rather than silently reusing an unknown dependency tree.
 * The symlink fallback deliberately shares writes; use only trusted checkouts.
 */
export async function prepareDependencies({ source, target, cloneTimeoutMs = 5000 }, injected = {}) {
  const started = performance.now();
  if (!Number.isInteger(cloneTimeoutMs) || cloneTimeoutMs < 1 || cloneTimeoutMs > 10000) {
    throw new Error('cloneTimeoutMs must be between 1 and 10000');
  }
  const [sourceRoot, targetRoot] = await Promise.all([realpath(source), realpath(target)]);
  const within = relative(sourceRoot, targetRoot);
  if (!within || within === 'node_modules' || within.startsWith(`node_modules${sep}`)) {
    throw new Error('Source and target dependency trees must be distinct');
  }
  const readFree = injected.freeBytes ?? freeBytes;
  const checkDisk = async () => {
    const available = await readFree(targetRoot);
    if ((typeof available !== 'number' && typeof available !== 'bigint') ||
        (typeof available === 'number' && !Number.isFinite(available)) || available < DISK_FLOOR_BYTES) {
      throw new Error('Bridge worktree requires at least 20 GiB free disk space');
    }
  };
  await checkDisk();
  const modules = join(sourceRoot, 'node_modules');
  // Clone a concrete tree. Following a source link could import a different
  // installation than the manifests just checked.
  if (!(await lstat(modules)).isDirectory()) throw new Error('Source node_modules must be a real directory');
  await manifestsMatch(sourceRoot, targetRoot);
  const destination = join(targetRoot, 'node_modules');
  const lock = join(targetRoot, '.bridge-dependencies.lock');
  await mkdir(lock, { mode: 0o700 });
  let stage;
  let published = false;
  let method = 'symlink';
  try {
    if (!await absent(destination)) throw new Error('Target node_modules already exists');
    stage = await mkdtemp(join(targetRoot, '.bridge-dependencies-'));
    const candidate = join(stage, 'node_modules');
    if ((injected.platform ?? process.platform) === 'darwin') {
      try {
        await (injected.clone ?? clone)(modules, candidate, cloneTimeoutMs);
        if (!(await lstat(candidate)).isDirectory()) throw new Error('Clone did not create a directory');
        method = 'apfs-clone';
      } catch {
        // The worker has exited (or been killed) before we touch its output.
        await rm(candidate, { recursive: true, force: true });
      }
    }
    if (method === 'symlink') await symlink(modules, candidate, 'dir');
    await manifestsMatch(sourceRoot, targetRoot);
    await checkDisk();
    if (!await absent(destination)) throw new Error('Target node_modules appeared during preparation');
    await rename(candidate, destination);
    published = true;
    await checkDisk();
  } catch (error) {
    if (published) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    // Best-effort cleanup: a cleanup error must not replace the outcome or
    // leave the lock behind to block every later preparation of this target.
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
  return { method, durationMs: Math.round(performance.now() - started) };
}

// Compare real paths: a symlinked invocation must still run (not exit 0 idle).
const isMain = () => {
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (process.argv[1] && isMain()) {
  const [source, target, ...rest] = process.argv.slice(2);
  if (!source || !target || rest.length) {
    console.error('Usage: node scripts/bridge-worktree.mjs SOURCE_CHECKOUT TARGET_WORKTREE');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await prepareDependencies({ source, target }))); }
    catch (error) {
      // Do not print child-process stderr or arbitrary filesystem content.
      console.error(`Bridge dependency preparation failed: ${error.code ?? 'validation-or-disk-floor'}`);
      process.exitCode = 1;
    }
  }
}
