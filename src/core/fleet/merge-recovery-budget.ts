import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fsyncDirectory } from '../util/durability.js';

export const MERGE_RECOVERY_ATTEMPTS = 3;

/** Reserve before an effect. Failed or interrupted calls spend a slot too.
 * Budgets belong to the source PR and action, so changing heads cannot reset them.
 * Exclusive files coordinate independent processes; previews create nothing.
 */
export async function reserveMergeRecoveryAttempt(root: string, pr: number, action: 'recut' | 'merge', apply: boolean): Promise<boolean> {
  if (!Number.isSafeInteger(pr) || pr < 1 || !['recut', 'merge'].includes(action)) throw new Error('invalid recovery');
  let dir = root;
  for (const segment of ['', 'queue', 'merge-recover']) {
    dir = join(dir, segment);
    try {
      if (apply) await mkdir(dir, { recursive: segment === '', mode: 0o700 });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    try {
      if (!(await lstat(dir)).isDirectory()) throw new Error('invalid recovery store');
    } catch (error) {
      if (!apply && (error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }
  for (let attempt = 0; attempt < MERGE_RECOVERY_ATTEMPTS; attempt++) {
    const path = join(dir, `${pr}-${action}-${attempt}`);
    if (!apply) {
      try { await lstat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
      continue;
    }
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    try { await handle.sync(); } finally { await handle.close(); }
    fsyncDirectory(dir);
    return true;
  }
  return false;
}
