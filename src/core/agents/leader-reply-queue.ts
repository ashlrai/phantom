/** Value-blind bounded scheduling for durable Leader reply queues. */
import { join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';

/** Persist the next position before transport work. Failed or rate-limited
 * deliveries retain their existing receipts without monopolizing the next pass.
 * Cursor files contain scheduling metadata only, never message text or handles.
 */
export function takeLeaderReplyBatch<T>(pending: readonly T[], directory: string, cursorName: 'network-cursor.json' | 'slack-reply-cursor.json'): T[] {
  ensurePrivateDirectory(directory);
  const file = join(directory, cursorName);
  const read = readStableRegularFile(file, { anchorPath: directory, maxFileBytes: 1024, remainingBytes: 1024 });
  let offset = 0;
  if (read.ok) {
    try {
      const value: unknown = JSON.parse(read.text);
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) offset = value;
    } catch { /* Malformed scheduling metadata restarts the round. */ }
  }
  const start = pending.length ? offset % pending.length : 0;
  const batch = [...pending.slice(start), ...pending.slice(0, start)].slice(0, 5);
  writePrivateFileAtomic(file, JSON.stringify(pending.length ? (start + batch.length) % pending.length : 0));
  return batch;
}
