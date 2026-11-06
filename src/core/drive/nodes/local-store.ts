import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../../fleet/local-store-lock.js';
import { fsyncDirectory } from '../../util/durability.js';
import { emptyState, parseState, type NodesState, type NodesStore } from './state.js';

/** Single-host authority. All nodes must use the same private directory.
 * Do not put this store on NFS or copy/reset it while nodes can still execute.
 */
export class LocalNodesStore implements NodesStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  transaction<T>(fn: (state: NodesState) => T): T {
    const lock = acquireLocalStoreLock(join(this.directory, 'nodes.lock'), 2_000, { exactPrivateStorage: true });
    if (!lock) throw new Error('Drive nodes store unavailable or contended');
    let temporary: string | undefined;
    let result: T;
    let released = false;
    try {
      const path = join(this.directory, 'nodes.json');
      let state: NodesState;
      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024 ||
            (process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600 ||
              (process.getuid && stat.uid !== process.getuid())))) {
          throw new Error('Unsafe drive nodes state');
        }
        state = parseState(JSON.parse(readFileSync(fd, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = emptyState();
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      result = structuredClone(fn(state));
      parseState(state);
      const bytes = JSON.stringify(state) + '\n';
      if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error('Drive nodes state capacity exceeded');
      const candidate = join(this.directory, `nodes.${randomUUID()}.tmp`);
      fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporary = candidate;
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      if (!ownsLocalStoreLock(lock)) throw new Error('Drive nodes store lock lost');
      renameSync(temporary, path);
      temporary = undefined;
      fsyncDirectory(this.directory);
    } finally {
      try {
        if (temporary) unlinkSync(temporary);
      } finally {
        released = releaseLocalStoreLock(lock);
      }
    }
    if (!released) throw new Error('Drive nodes store lock release failed');
    return result;
  }
}
