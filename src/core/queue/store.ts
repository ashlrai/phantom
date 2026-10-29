import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory, readPrivateFileCapped } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { controlQueue, type QueueControlDecision } from './controller.js';

/** One atomic envelope is the journal for BOTH bandit and LP consumers: no split writes. */
export async function writeQueueDecision(root: string, decision: QueueControlDecision): Promise<{ path: string; replayed: boolean }> {
  // Reject hand-crafted or mutated decisions before constructing paths or acquiring a lock.
  const checked = controlQueue(decision.input);
  const serialized = JSON.stringify(checked);
  if (serialized !== JSON.stringify(decision)) throw new Error('queue: decision does not match its input');
  if (Buffer.byteLength(serialized, 'utf8') + 1 > 4 * 1024 * 1024) throw new Error('queue: decision exceeds storage limit');
  const directory = resolve(root);
  ensurePrivateDirectory(directory);
  const acquired = acquireLocalStoreLockWithOutcome(join(directory, '.queue-control.lock'), 0, {
    anchorPath: directory, exactPrivateStorage: true,
  });
  if (acquired.state !== 'acquired') throw new Error(`queue: decision store ${acquired.state}`);
  const persist = (): { path: string; replayed: boolean } => {
    const streamDirectory = join(directory, checked.input.stream);
    ensurePrivateDirectory(streamDirectory);
    const path = join(streamDirectory, `${checked.observedAt}.json`);
    let exists = false;
    try { lstatSync(path); exists = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('queue: cannot inspect decision');
    }
    if (exists) {
      const prior = readPrivateFileCapped(path, 4 * 1024 * 1024);
      if (!prior || prior.truncated || prior.text !== `${serialized}\n`) throw new Error('queue: conflicting or unreadable decision for observation');
      return { path, replayed: true };
    }
    const names = readdirSync(streamDirectory);
    if (names.some((name) => /^\d+\.json$/.test(name) && Number(name.slice(0, -5)) > checked.observedAt)) {
      throw new Error('queue: out-of-order observation');
    }
    writePrivateFileAtomically(join(streamDirectory, `.${randomUUID()}.tmp`), path, `${serialized}\n`, {
      anchorPath: directory, label: 'queue control decision',
    });
    return { path, replayed: false };
  };
  let result: { path: string; replayed: boolean };
  let released = false;
  try {
    result = persist();
  } finally {
    released = releaseLocalStoreLock(acquired.lock);
  }
  if (!released) throw new Error('queue: decision store lock release failed; inspect before retry');
  return result;
}
