import { closeSync, fstatSync, lstatSync, openSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../core/verse/preferences.js';
import { decodeReplayFleet, encodeReplayFleet, REPLAY_MAX_BYTES, ReplayHarnessError, type ReplayFleet } from './replay-codec.js';

export function readReplayFleet(path: string): ReplayFleet {
  try {
    const parent = lstatSync(dirname(resolve(path)));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new ReplayHarnessError('storage');
    const file = readPrivateFileCapped(path, REPLAY_MAX_BYTES);
    if (!file || file.truncated) throw new ReplayHarnessError('storage');
    return decodeReplayFleet(file.text);
  } catch (error) {
    if (error instanceof ReplayHarnessError) throw error;
    throw new ReplayHarnessError('storage');
  }
}

/** A writer owns the whole recording, including awaits. Never steal a stale
 * lock automatically: its session may have an external effect still in flight. */
export function lockReplayFleet(path: string): { fleet: ReplayFleet; save(): void; release(): void } {
  const target = resolve(path);
  const lock = `${target}.replay-lock`;
  let fd: number;
  try {
    ensurePrivateDirectory(dirname(target));
    fd = openSync(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ReplayHarnessError('busy');
    throw new ReplayHarnessError('storage');
  }
  const identity = fstatSync(fd);
  let released = false;
  function release(): void {
    if (released) return;
    released = true;
    try {
      const current = lstatSync(lock);
      if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ReplayHarnessError('storage');
    } finally { closeSync(fd); }
  }
  try {
    let fleet: ReplayFleet;
    try {
      lstatSync(target);
      fleet = readReplayFleet(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fleet = { schema: 'phantom-fleet-replay/v1', sessions: [] };
    }
    return {
      fleet,
      save() {
        try {
          const current = lstatSync(lock);
          if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
            throw new ReplayHarnessError('storage');
          }
          writePrivateFileAtomic(target, encodeReplayFleet(fleet));
        } catch (error) {
          if (error instanceof ReplayHarnessError) throw error;
          throw new ReplayHarnessError('storage');
        }
      },
      release,
    };
  } catch (error) {
    release();
    if (error instanceof ReplayHarnessError) throw error;
    throw new ReplayHarnessError('storage');
  }
}
