import { mkdir, readFile, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { validateRecord, type SyncAdapter, type SyncSnapshot } from './twoway-sync.js';

/** One snapshot per explicit path. Lock and compare protect concurrent cooperating writers. */
export function fileSyncAdapter(path: string): SyncAdapter {
  const read = async (): Promise<SyncSnapshot | undefined> => {
    try {
      const snapshot = JSON.parse(await readFile(path, 'utf8')) as SyncSnapshot;
      validateRecord(snapshot.record);
      if (!Array.isArray(snapshot.conflicts)) throw new Error('Invalid sync conflict archive');
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  return { read, async write(next, expected) {
    validateRecord(next.record);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await mkdir(`${path}.lock`, { mode: 0o700 });
    try {
      if (!equal(await read(), expected)) throw new Error('Sync file changed; read and reconcile again');
      const conflicts = [...(expected?.conflicts ?? []), ...next.conflicts];
      const unique = conflicts.filter((row, i) => conflicts.findIndex(other => equal(row, other)) === i);
      writePrivateFileAtomically(`${path}.${randomUUID()}.tmp`, path,
        JSON.stringify({ record: next.record, conflicts: unique }), { anchorPath: dirname(path), label: 'Sync snapshot' });
    } finally { await rmdir(`${path}.lock`); }
  } };
}
