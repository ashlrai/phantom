import { closeSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../core/fleet/local-store-lock.js';
import { assurePrivateStoragePath } from '../core/util/private-storage.js';
import { fsyncDirectory } from '../core/util/durability.js';

const MAX_BYTES = 8192;

/** One consumer per checkpoint. The private parent must already exist. */
export function openBusCheckpoint(path: string, filters: Record<string, string | undefined>): {
  cursor: number; save: (cursor: number) => void; close: () => void;
} {
  if (!isAbsolute(path)) throw new Error('checkpoint requires an absolute path');
  const parent = dirname(path), stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
    (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error('checkpoint requires an existing private owned directory');
  }
  if (!assurePrivateStoragePath(parent, 'directory', 'inspect-existing', { anchorPath: parent }).ok) throw new Error('unsafe checkpoint directory');
  const canonicalParent = realpathSync(parent);
  const identity = JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  const acquired = acquireLocalStoreLockWithOutcome(`${path}.lock`, 0, { anchorPath: parent, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') throw new Error(`checkpoint lock ${acquired.state}`);
  const lock = acquired.lock;
  const read = (): string | undefined => {
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const result = readStableRegularFile(path, { anchorPath: parent, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
    if (!result.ok) throw new Error('unsafe or unreadable checkpoint');
    return result.text;
  };
  try {
    let previous = read();
    let cursor = 0;
    if (previous !== undefined) {
      let state;
      try { state = JSON.parse(previous); } catch { throw new Error('corrupt checkpoint'); }
      if (!state || Object.keys(state).sort().join(',') !== 'filters,scanCursor,version' || state.version !== 1 ||
        !Number.isSafeInteger(state.scanCursor) || state.scanCursor < 0 || typeof state.filters !== 'string') throw new Error('corrupt checkpoint');
      if (state.filters !== identity) throw new Error('checkpoint filter mismatch');
      cursor = state.scanCursor;
    }
    return { cursor, close: () => { releaseLocalStoreLock(lock); }, save: (next) => {
      const temp = join(parent, `.bus-checkpoint-${randomUUID()}`);
      let fd: number | undefined;
      try {
        if (!ownsLocalStoreLock(lock) || realpathSync(parent) !== canonicalParent || read() !== previous) throw new Error('checkpoint changed during consumption');
        const text = JSON.stringify({ version: 1, scanCursor: next, filters: identity }) + '\n';
        if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('checkpoint too large');
        fd = openSync(temp, 'wx', 0o600);
        if (!assurePrivateStoragePath(temp, 'file', 'secure-created', { anchorPath: parent }).ok) throw new Error('unsafe checkpoint temporary');
        writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined;
        if (read() !== previous) throw new Error('checkpoint changed during persistence');
        if (previous === undefined) linkSync(temp, path); // Exclusive publication: never overwrite an existing unrelated file.
        else renameSync(temp, path);
        fsyncDirectory(parent);
        previous = text;
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    } };
  } catch (error) { releaseLocalStoreLock(lock); throw error; }
}
