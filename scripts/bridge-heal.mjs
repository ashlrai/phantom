/**
 * Self-heal for the source checkout whose node_modules the bridge clones.
 * Probes the same tools `phm doctor worktree` checks (tsgo, eslint), repairs
 * the source once with `npm ci` under a lock, and records every step as one
 * JSON line. Never throws for a failed repair: the caller falls back to
 * cloning as before and prints one plain line.
 */
import { spawnSync, execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { appendFile, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const HEAL_SCHEMA = 'phm.bridge.source-heal/1';
export const REPAIR_COMMAND = 'npm ci --ignore-scripts --no-audit --no-fund';
export const LOCK_WAIT_MS = 10 * 60 * 1000;
export const REPAIR_INTERVAL_MS = 60 * 60 * 1000;
const NPM_TIMEOUT_MS = 15 * 60 * 1000;

/** State files live in .git when the source has one (keeps git status clean), else in the source root. */
export function healPaths(source) {
  const git = join(source, '.git');
  let dir = source;
  try { if (statSync(git).isDirectory()) dir = git; } catch { /* no .git directory */ }
  return { lock: join(dir, 'bridge-source-repair.lock'), stamp: join(dir, 'bridge-source-repair.stamp'), log: join(dir, 'bridge-source-repair.jsonl') };
}

const starts = (command, args, cwd) => spawnSync(command, args, { cwd, stdio: 'ignore', timeout: 20_000 }).status === 0;

/** Same checks as src/core/worktree-doctor.ts: the tsgo bin starts; eslint's lib exists and its bin starts. */
export function probeSource(source) {
  const modules = join(source, 'node_modules');
  const tsgoBin = join(modules, '.bin', 'tsgo');
  const tsgo = existsSync(tsgoBin) && starts(tsgoBin, ['--version'], source);
  const eslint = existsSync(join(modules, 'eslint', 'lib', 'cli.js')) &&
    starts(process.execPath, [join(modules, 'eslint', 'bin', 'eslint.js'), '--version'], source);
  return { ok: tsgo && eslint, tsgo, eslint };
}

async function realNpm(cwd) {
  try { await exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, timeout: NPM_TIMEOUT_MS, maxBuffer: 1024 * 1024 }); return true; }
  catch { return false; }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * @returns {Promise<{ok: boolean, action: 'none'|'repaired'|'failed'|'skipped', reason: string}>}
 */
export async function healSource({ source }, injected = {}) {
  const now = injected.now ?? Date.now;
  const probe = injected.probe ?? probeSource;
  const npm = injected.npm ?? realNpm;
  const lockWaitMs = injected.lockWaitMs ?? LOCK_WAIT_MS;
  const paths = healPaths(source);
  const record = async (event, fields) => {
    const line = JSON.stringify({ schema: HEAL_SCHEMA, at: new Date(now()).toISOString(), event, ...fields });
    try { await appendFile(paths.log, `${line}\n`); } catch { /* the log is best effort */ }
  };
  const finish = async (ok, action, reason, state) => {
    await record(action === 'none' ? 'probe' : action, { ok, reason, tsgo: state.tsgo, eslint: state.eslint });
    return { ok, action, reason };
  };

  let state = probe(source);
  if (state.ok) return finish(true, 'none', 'source tools start', state);

  // Another process may be repairing right now; wait for it, never run two npm ci in one folder.
  const waitUntil = now() + lockWaitMs;
  for (;;) {
    try { await mkdir(paths.lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') return finish(false, 'skipped', `could not take the repair lock (${error.code ?? 'error'})`, state);
      if (now() >= waitUntil) return finish(false, 'skipped', 'another repair has held the lock for over 10 minutes', state);
      await sleep(injected.pollMs ?? 1000);
    }
  }
  try {
    // A waiter re-probes: the other process may have fixed the source.
    state = probe(source);
    if (state.ok) return finish(true, 'none', 'source tools start', state);
    try {
      const last = (await stat(paths.stamp)).mtimeMs;
      if (now() - last < REPAIR_INTERVAL_MS) return finish(false, 'skipped', 'already repaired within the last hour', state);
    } catch { /* no stamp yet */ }
    // Stamp first so a failed or killed repair still counts toward the hourly limit.
    await writeFile(paths.stamp, `${new Date(now()).toISOString()}\n`);
    await utimes(paths.stamp, new Date(now()), new Date(now()));
    const success = await npm(source);
    state = probe(source);
    if (success && state.ok) return finish(true, 'repaired', REPAIR_COMMAND, state);
    return finish(false, 'failed', success ? 'repair ran but tools still do not start' : 'repair command failed', state);
  } finally {
    await rm(paths.lock, { recursive: true, force: true });
  }
}
