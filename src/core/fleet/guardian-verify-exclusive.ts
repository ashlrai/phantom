import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { runGuardianVerifyLoop, type GuardianOptions, type GuardianSummary } from './guardian-verify-loop.js';
import {
  acquireLocalStoreLockWithOutcome,
  releaseLocalStoreLock,
  type LocalStoreLock,
  type LocalStoreLockAcquireResult,
} from './local-store-lock.js';

/**
 * Local-host exclusion for one guardian state file. This is NOT host election and
 * NOT network-filesystem locking: the lock is a file next to the canonical state
 * file, so two guardians on different hosts sharing an NFS/SMB mount are not
 * guaranteed to exclude each other. Ownership is reclaimed only when the owning
 * process is provably dead (local-store-lock); a live lease is never stolen because
 * time passed, so a hung guardian keeps the state locked until it exits.
 */

/**
 * 'already-running': a live guardian in this host's process table holds the state lock.
 * 'lock-unavailable': the lock could not be acquired or its holder could not be verified
 * (for example a foreign owner whose start time cannot be probed). Neither runs checks.
 */
export type GuardianVerifyRefusal = 'already-running' | 'lock-unavailable';
export type GuardianVerifyExclusiveResult =
  | { state: 'ran'; summary: GuardianSummary }
  | { state: 'refused'; reason: GuardianVerifyRefusal };

export interface GuardianVerifyExclusiveDeps {
  run?: (options: GuardianOptions) => Promise<GuardianSummary>;
  acquire?: (lockPath: string) => LocalStoreLockAcquireResult;
  release?: (lock: LocalStoreLock) => boolean;
}

/**
 * Lock path keyed by the canonical state target: the parent directory is
 * realpath'd so symlinked or `..`-spelled aliases share one lock, and a symlinked
 * state file is followed. Throws for paths the loop itself would reject, before any
 * filesystem access.
 */
export function guardianVerifyLockPath(state: string): string {
  if (!isAbsolute(state) || state.includes('\0')) throw new Error('invalid state path');
  const name = basename(state);
  if (name === '' || name === '.' || name === '..') throw new Error('invalid state path');
  let target = join(realpathSync(dirname(state)), name);
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) target = realpathSync(target);
  return `${target}.guardian-verify.lock`;
}

/**
 * Acquires the state lock before the loop reads state or any verifier runs. A live
 * holder yields `already-running` without waiting (waitMs 0); the loop is never
 * invoked and the state file is not touched. The lock is released in `finally`, so
 * it is released only after the run has settled, including on rejection or abort.
 */
export async function runGuardianVerifyExclusive(
  options: GuardianOptions,
  deps: GuardianVerifyExclusiveDeps = {},
): Promise<GuardianVerifyExclusiveResult> {
  const lockPath = guardianVerifyLockPath(options.state);
  const acquired = (deps.acquire ?? ((path: string) => acquireLocalStoreLockWithOutcome(path, 0)))(lockPath);
  if (acquired.state !== 'acquired') {
    return { state: 'refused', reason: acquired.state === 'contended' ? 'already-running' : 'lock-unavailable' };
  }
  try {
    return { state: 'ran', summary: await (deps.run ?? runGuardianVerifyLoop)(options) };
  } finally {
    // A false return keeps the lock queued for retry inside local-store-lock; it is never reclaimed while live.
    (deps.release ?? releaseLocalStoreLock)(acquired.lock);
  }
}
