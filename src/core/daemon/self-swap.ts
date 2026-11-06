import { lstatSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLocalStoreLock, releaseLocalStoreLock, type VerifiedProcessStartIdentity } from '../fleet/local-store-lock.js';
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';

export interface SelfSwapOptions { root: string; next: string; oldPid: number; sparePort: number }
export interface SelfSwapRuntime {
  identify(pid: number): VerifiedProcessStartIdentity | undefined;
  build(directory: string): Promise<void>;
  probe(directory: string, port: number): Promise<{ healthy(): Promise<boolean>; close(): Promise<void> }>;
  drain(pid: number, identity: VerifiedProcessStartIdentity): Promise<void>;
}
interface Journal {
  previous: string; next: string; oldPid: number; identity: VerifiedProcessStartIdentity;
  phase: 'building' | 'probing' | 'draining';
}
const JOURNAL = '.self-swap.json';
const versionName = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name);

function version(root: string, name: string): string {
  if (!versionName(name)) throw new Error('Invalid version directory name');
  const directory = join(root, 'versions', name);
  if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw new Error('Version must be a real directory inside versions');
  return directory;
}
function current(root: string): string {
  const target = resolve(root, readlinkSync(join(root, 'current')));
  if (version(root, basename(target)) !== target) throw new Error('current must point inside versions');
  return basename(target);
}
function flip(root: string, name: string): void {
  const temporary = join(root, `.self-swap-${randomUUID()}`);
  symlinkSync(join('versions', name), temporary);
  try { renameSync(temporary, join(root, 'current')); fsyncDirectory(root); }
  catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the original rename/durability failure. */ }
    throw error;
  }
}
function save(root: string, journal: Journal): void {
  writePrivateFileAtomically(join(root, `.self-swap-${randomUUID()}.json`), join(root, JOURNAL), JSON.stringify(journal), { anchorPath: root, label: 'self-swap journal' });
}
function clear(root: string): void { unlinkSync(join(root, JOURNAL)); fsyncDirectory(root); }
function rootPath(path: string): string {
  const root = realpathSync(path);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Install root must be owned by this user and not writable by others');
  return root;
}

/** Read-only: no lock, subprocess, network request or filesystem write. */
export function planSelfSwap(options: SelfSwapOptions) {
  const root = rootPath(options.root);
  const previous = current(root);
  version(root, options.next);
  if (previous === options.next) throw new Error('Candidate is already current');
  if (!Number.isSafeInteger(options.oldPid) || options.oldPid <= 1 || options.oldPid === process.pid) throw new Error('An independent old process PID is required');
  if (!Number.isInteger(options.sparePort) || options.sparePort < 0 || options.sparePort > 65535) throw new Error('Invalid spare port');
  return { mode: 'plan', root, previous, next: options.next, oldPid: options.oldPid, sparePort: options.sparePort,
    steps: ['build next', 'probe read-only web server', 'journal and atomically flip current', 'probe again', 'close probe', 'commit selection', 'SIGTERM old process and await exit'],
    prerequisite: 'Existing supervisor must restart through current; resident activation gates still apply. Web health is not resident readiness.' };
}

/** Write-ahead recovery never signals a PID from an uncommitted flip. */
async function recover(root: string, runtime: SelfSwapRuntime) {
  let journal: Journal;
  try {
    const path = join(root, JOURNAL);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 4096) throw new Error('Invalid self-swap journal');
    journal = JSON.parse(readFileSync(path, 'utf8')) as Journal;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!journal || !['building', 'probing', 'draining'].includes(journal.phase) ||
      typeof journal.previous !== 'string' || typeof journal.next !== 'string' || journal.previous === journal.next ||
      !Number.isSafeInteger(journal.oldPid) || journal.oldPid <= 1 || journal.oldPid === process.pid ||
      !journal.identity || !/^[a-f0-9]{64}$/.test(journal.identity.ref) ||
      !['ps-lstart', 'linux-proc-start-ticks', 'windows-start-ticks'].includes(journal.identity.source)) throw new Error('Invalid self-swap journal');
  if (journal.phase === 'building') throw new Error('Interrupted build requires operator inspection before removing its journal');
  version(root, journal.previous); version(root, journal.next);
  const selected = current(root);
  if (selected !== journal.previous && selected !== journal.next) throw new Error('current changed outside self-swap; refusing recovery');
  if (journal.phase === 'probing') {
    if (selected === journal.next) flip(root, journal.previous);
    clear(root);
    return { mode: 'recovered', current: journal.previous };
  }
  if (selected !== journal.next) throw new Error('Committed selection changed; refusing drain');
  fsyncDirectory(root); // Re-establish the commit barrier after an ambiguous interrupted write.
  await runtime.drain(journal.oldPid, journal.identity);
  clear(root);
  return { mode: 'applied', current: journal.next };
}

export async function applySelfSwap(options: SelfSwapOptions, runtime: SelfSwapRuntime) {
  if (process.platform === 'win32') throw new Error('Self-swap requires POSIX symlink and signal semantics');
  const root = rootPath(options.root);
  const lock = acquireLocalStoreLock(join(root, '.self-swap.lock'), 0, { anchorPath: root });
  if (!lock) throw new Error('Self-swap is busy or its lock is unavailable');
  try {
    const recovered = await recover(root, runtime);
    if (recovered) return recovered; // Recovery is a complete operation, never an implicit new update.
    const plan = planSelfSwap(options);
    const identity = runtime.identify(options.oldPid);
    if (!identity) throw new Error('Cannot verify old process identity');
    // A killed updater can leave build descendants alive. Keep a durable fence
    // until the build succeeds; never automatically rebuild potentially live bytes.
    const journal: Journal = { previous: plan.previous, next: plan.next, oldPid: options.oldPid, identity, phase: 'building' };
    save(root, journal);
    await runtime.build(version(root, plan.next));
    journal.phase = 'probing';
    save(root, journal);
    if (current(root) !== plan.previous) throw new Error('current changed during build');
    let probe: Awaited<ReturnType<SelfSwapRuntime['probe']>> | undefined;
    let committed = false;
    try {
      probe = await runtime.probe(version(root, plan.next), options.sparePort);
      if (!await probe.healthy()) throw new Error('Candidate health probe failed');
      if (current(root) !== plan.previous) throw new Error('current changed during probe');
      flip(root, plan.next);
      if (!await probe.healthy()) throw new Error('Candidate post-flip health probe failed');
      await probe.close();
      // Once drain can begin the old process may be gone. Recovery must finish
      // the handoff, never restore an installation whose process was stopped.
      if (current(root) !== plan.next) throw new Error('current changed before drain');
      journal.phase = 'draining';
      committed = true; // A failed write may already have published; leave recovery to a new invocation.
      save(root, journal);
      await runtime.drain(options.oldPid, identity);
      clear(root);
      return { mode: 'applied', current: plan.next };
    } catch (error) {
      if (!committed) await recover(root, runtime);
      throw error;
    } finally { await probe?.close(); }
  } finally { releaseLocalStoreLock(lock); }
}
