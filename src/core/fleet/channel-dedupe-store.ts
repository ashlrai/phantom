/** Successful receipts only. The sink append and receipt commit are separate:
 * a crash between them can append again on retry; this is not exactly-once. */
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';

export const CHANNEL_RECEIPT_LIMIT = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
export interface ChannelReceipt { at: number; key: string }
export interface ChannelDedupeStore {
  /** Serialize lookup, awaited sink persistence, and commit across all users.
   * Commit must persist before resolving. Exceptions fail the receive explicitly. */
  transaction<T>(work: (receipts: Map<string, ChannelReceipt>, commit: () => void | Promise<void>) => Promise<T>): Promise<T>;
}

export function createLocalChannelDedupeStore(runsDir = join(homedir(), '.ashlr-runs')): ChannelDedupeStore {
  const parent = resolve(runsDir, 'channel-receipts');
  const file = join(parent, 'receipts.json');
  return {
    async transaction(work) {
      const deadline = Date.now() + 2_000;
      let acquired = acquireLocalStoreLockWithOutcome(join(parent, 'receipts.lock'), 0);
      while (acquired.state === 'contended' && Date.now() < deadline) {
        // Never block the event loop while another receiver awaits its sink.
        await delay(10);
        acquired = acquireLocalStoreLockWithOutcome(join(parent, 'receipts.lock'), 0);
      }
      if (acquired.state !== 'acquired') throw new Error('Channel receipt lock unavailable');
      const { lock } = acquired;
      try {
        const receipts = new Map<string, ChannelReceipt>();
        let exists = true;
        try { lstatSync(file); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          exists = false;
        }
        if (exists) {
          const read = readStableRegularFile(file, { anchorPath: parent, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
          if (!read.ok) throw new Error('Channel receipts unreadable');
          const rows: unknown = JSON.parse(read.text);
          if (!Array.isArray(rows) || rows.length > CHANNEL_RECEIPT_LIMIT) throw new Error('Invalid channel receipts');
          for (const row of rows) {
            if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== 'string' || typeof row[2] !== 'string' || !/^[a-f0-9]{64}$/.test(row[0]) ||
                !/^[a-f0-9]{64}$/.test(row[2]) || !Number.isSafeInteger(row[1]) || row[1] < 0 ||
                receipts.has(row[0])) throw new Error('Invalid channel receipt');
            receipts.set(row[0], { at: row[1], key: row[2] });
          }
        }
        return await work(receipts, () => {
          if (!ownsLocalStoreLock(lock) || receipts.size > CHANNEL_RECEIPT_LIMIT) throw new Error('Channel receipt commit unavailable');
          const text = JSON.stringify([...receipts].map(([hash, receipt]) => [hash, receipt.at, receipt.key]));
          if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Channel receipts too large');
          writePrivateFileAtomically(join(parent, `.${randomUUID()}.tmp`), file, text,
            { anchorPath: parent, label: 'Channel receipts' });
        });
      } finally { releaseLocalStoreLock(lock); }
    },
  };
}
